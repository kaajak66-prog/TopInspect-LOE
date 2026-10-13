"""Unsupervised training with MAD self-training loop.

Phase 1 — Warm-up: standard MSE reconstruction on all data (benign + attacks mixed).
Phase 2 — Self-training: MAD pseudo-labeling + label-aware loss, iterated.

No labels are used at any stage — not for filtering training data, not for
threshold selection, not for pseudo-label generation.
"""

import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from tqdm import tqdm

from utils.dataloaders import SequentialDataset, collate_fn
from utils.trainers import calculate_errors, find_threshold, validate, test  # noqa: F401


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def _masked_mse(outputs, targets, masks):
    """Masked MSE: average per-element squared error over valid positions only."""
    criterion = nn.MSELoss(reduction="none")
    loss = criterion(outputs, targets)
    return torch.sum(loss * masks) / torch.clamp(torch.sum(masks), min=1)


def _mad_pseudo_labels(seq_errors, multiplier=5.0):
    """Generate binary pseudo-labels via Median Absolute Deviation.

    Returns
    -------
    is_anomaly : torch.BoolTensor
        True where the sequence error exceeds ``median + multiplier * MAD``.
    threshold : float
        The MAD threshold used (for logging).
    """
    median = seq_errors.median()
    mad = (seq_errors - median).abs().median() * 1.4826
    threshold = median + multiplier * mad
    return seq_errors > threshold, threshold.item()


def _loe_pseudo_labels(seq_errors, contamination_rate=0.05):
    """LOE (Latent Outlier Exposure) style pseudo-labeling.

    Instead of a statistical threshold, labels the top ``contamination_rate``
    fraction of samples (highest reconstruction error) as anomalies.

    This is the core idea from the ICML 2022 LOE paper: the model jointly
    infers which samples are contaminated and trains on the inferred labels.

    Returns
    -------
    is_anomaly : torch.BoolTensor
        True for the top α fraction by reconstruction error.
    threshold : float
        The error value at the α-quantile (for logging).
    """
    k = max(1, int(len(seq_errors) * contamination_rate))
    threshold = seq_errors.topk(k, largest=True).values[-1].item()
    is_anomaly = seq_errors >= threshold
    # Edge case: when errors are too uniform (all nearly equal),
    # >= would label everything. Clamp to at most 2× contamination.
    anomaly_frac = is_anomaly.float().mean().item()
    if anomaly_frac > min(contamination_rate * 4, 0.5):
        is_anomaly = torch.zeros_like(seq_errors, dtype=torch.bool)
        is_anomaly[seq_errors.topk(k, largest=True).indices] = True
    return is_anomaly, threshold


# ---------------------------------------------------------------------------
# Main training loop
# ---------------------------------------------------------------------------


def train_unsupervised(
    model,
    window_size,
    step_percent,
    ae_batch_size,
    train_loader,
    val_loader,
    start_epoch,
    num_epochs,
    optimizer,
    run,
    patience,
    checkpoint,
    device="cuda",
    num_self_train_rounds=3,
    mad_multiplier=5.0,
    attack_loss_weight=1.0,
    loe_mode=False,
    contamination_rate=0.05,
):
    """Train GraphIDS/TopInspect without ANY labels.

    Parameters
    ----------
    num_self_train_rounds : int
        Number of self-training rounds after warm-up (default 3).
    mad_multiplier : float
        Multiplier for MAD threshold (ignored in LOE mode).
    attack_loss_weight : float
        Weight of the anomaly-push term in the label-aware loss (default 1.0).
    loe_mode : bool
        If True, use LOE-style top-α labeling instead of MAD.
    contamination_rate : float
        LOE contamination prior α — fraction of samples assumed anomalous
        (default 0.05).
    """
    step = max(1, int(window_size * step_percent))
    criterion = nn.MSELoss(reduction="none")

    # ====================================================================
    # Phase 1 — Warm-up: standard MSE on ALL data
    # ====================================================================
    print(f"[Phase 1] Warm-up training ({num_epochs} epochs, standard MSE)")

    best_val_loss = float("inf")
    cnt_wait = 0

    for epoch in (pbar := tqdm(range(start_epoch + 1, num_epochs + 1), desc="Warm-up")):
        total_train_loss = 0.0
        model.train()

        for batch in train_loader:
            batch.batch_edge_couples = batch.edge_label_index.t()
            batch = batch.to(device)

            train_emb = model.encoder(
                batch.edge_index,
                batch.edge_attr,
                batch.batch_edge_couples,
                batch.num_nodes,
            )
            ae_train_loader = DataLoader(
                SequentialDataset(
                    train_emb, window=window_size, step=step, device=device
                ),
                batch_size=ae_batch_size,
                collate_fn=collate_fn,
            )

            accumulated_loss = torch.tensor(0.0, device=device)
            seq_count = 0
            for ae_batch, mask in ae_train_loader:
                outputs = model.transformer(ae_batch, mask)
                loss = criterion(outputs, ae_batch)
                loss = torch.sum(loss * mask) / torch.sum(mask)
                accumulated_loss += loss
                seq_count += 1

            if seq_count > 0:
                loss = accumulated_loss / seq_count
                total_train_loss += loss.item()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                optimizer.step()
                optimizer.zero_grad()

        total_train_loss /= len(train_loader)
        val_loss, val_errors, val_labels = validate(
            model, val_loader, ae_batch_size, window_size, device
        )

        # Model selection by validation LOSS — fully unsupervised.
        if val_loss < best_val_loss:
            best_val_loss = val_loss
            threshold = find_threshold(
                val_errors,
                method="unsupervised",
                contamination=contamination_rate,
            )
            model.save_checkpoint(
                checkpoint,
                optimizer=optimizer,
                epoch=epoch,
                threshold=threshold,
            )
            cnt_wait = 0
        else:
            cnt_wait += 1

        pbar.set_postfix(
            {"train_loss": total_train_loss, "val_loss": val_loss}
        )
        run.log(
            {
                "phase": "warmup",
                "train_loss": total_train_loss,
                "val_loss": val_loss,
            }
        )

        if cnt_wait >= patience:
            print("Early stopping!")
            break

    # Load best warm-up checkpoint
    chk = torch.load(checkpoint, weights_only=True)
    model.load_state_dict(chk["model_state_dict"])
    threshold = chk.get("threshold", None)

    # ====================================================================
    # Phase 2 — Self-Training (MAD or LOE)
    # ====================================================================
    mode_label = f"LOE (α={contamination_rate})" if loe_mode else "MAD"
    print(f"\n[Phase 2] {mode_label} self-training ({num_self_train_rounds} rounds)")

    for round_idx in range(1, num_self_train_rounds + 1):
        print(f"\n--- Self-training round {round_idx}/{num_self_train_rounds} ---")

        total_train_loss = 0.0
        total_normal = 0
        total_anomaly = 0
        all_mad_thresholds = []
        model.train()

        for batch in train_loader:
            batch.batch_edge_couples = batch.edge_label_index.t()
            batch = batch.to(device)

            # ---- Encoder forward (shared) ----
            embeddings = model.encoder(
                batch.edge_index,
                batch.edge_attr,
                batch.batch_edge_couples,
                batch.num_nodes,
            )

            ae_train_loader = DataLoader(
                SequentialDataset(
                    embeddings, window=window_size, step=step, device=device
                ),
                batch_size=ae_batch_size,
                collate_fn=collate_fn,
            )

            # ---- Single forward pass: collect outputs + errors ----
            all_outputs = []
            all_ae_batches = []
            all_masks = []
            all_errors = []

            for ae_batch, mask in ae_train_loader:
                outputs = model.transformer(ae_batch, mask)
                all_outputs.append(outputs)
                all_ae_batches.append(ae_batch)
                all_masks.append(mask)
                all_errors.append(calculate_errors(outputs, ae_batch, mask).detach())

            if not all_errors:
                continue

            # ---- Pseudo-labeling (MAD or LOE) ----
            batch_errors = torch.cat(all_errors)
            if loe_mode:
                is_anomaly, threshold_val = _loe_pseudo_labels(
                    batch_errors, contamination_rate
                )
            else:
                is_anomaly, threshold_val = _mad_pseudo_labels(
                    batch_errors, mad_multiplier
                )
            all_mad_thresholds.append(threshold_val)

            total_normal += (~is_anomaly).sum().item()
            total_anomaly += is_anomaly.sum().item()

            # ---- Label-aware loss using pseudo-labels ----
            accumulated_loss = torch.tensor(0.0, device=device)
            seq_count = 0
            current_idx = 0

            for outputs, ae_batch, mask in zip(all_outputs, all_ae_batches, all_masks):
                bs = ae_batch.size(0)
                sub_is_anomaly = is_anomaly[current_idx : current_idx + bs]
                current_idx += bs

                # normal → pull toward reconstruction (minimize MSE)
                # anomaly → push away from reconstruction (maximize MSE)
                loss = torch.tensor(0.0, device=device)
                norm_mask = ~sub_is_anomaly
                anom_mask = sub_is_anomaly

                if norm_mask.any():
                    loss = loss + _masked_mse(
                        outputs[norm_mask], ae_batch[norm_mask], mask[norm_mask]
                    )
                if anom_mask.any():
                    loss = loss - attack_loss_weight * _masked_mse(
                        outputs[anom_mask], ae_batch[anom_mask], mask[anom_mask]
                    )

                accumulated_loss += loss
                seq_count += 1

            if seq_count > 0:
                loss = accumulated_loss / seq_count
                total_train_loss += loss.item()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                optimizer.step()
                optimizer.zero_grad()

        total_train_loss /= max(len(train_loader), 1)

        # ---- Validation ----
        val_loss, val_errors, val_labels = validate(
            model, val_loader, ae_batch_size, window_size, device
        )
        threshold = find_threshold(
            val_errors,
            method="unsupervised",
            contamination=contamination_rate,
        )

        # Save checkpoint for this round
        model.save_checkpoint(
            checkpoint,
            optimizer=optimizer,
            epoch=round_idx,
            threshold=threshold,
        )

        # ---- Logging ----
        total = max(total_normal + total_anomaly, 1)
        avg_mad_threshold = (
            sum(all_mad_thresholds) / len(all_mad_thresholds)
            if all_mad_thresholds
            else 0.0
        )

        print(
            f"  Round {round_idx} | "
            f"Pseudo-labels: {100*total_normal/total:.1f}% normal / "
            f"{100*total_anomaly/total:.1f}% anomaly | "
            f"Avg MAD threshold: {avg_mad_threshold:.6f} | "
            f"Train loss: {total_train_loss:.6f} | "
            f"Val loss: {val_loss:.6f}"
        )

        run.log(
            {
                "phase": f"self_train_round_{round_idx}",
                "train_loss": total_train_loss,
                "val_loss": val_loss,
                "pseudo_normal_pct": 100 * total_normal / total,
                "pseudo_anomaly_pct": 100 * total_anomaly / total,
                "avg_mad_threshold": avg_mad_threshold,
            }
        )

    # Load best checkpoint and return
    chk = torch.load(checkpoint, weights_only=True)
    model.load_state_dict(chk["model_state_dict"])
    return model, chk["threshold"]
