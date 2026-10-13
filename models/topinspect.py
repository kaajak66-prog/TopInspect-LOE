import torch
import torch.nn as nn
from torch_geometric.nn import MessagePassing
from torch_geometric.utils import scatter


class SAGELayer(MessagePassing):
    def __init__(self, ndim_in, edim_in, edim_out, agg_type="mean", dropout_rate=0.0):
        super().__init__(aggr=agg_type)
        self.fc_neigh = nn.Linear(edim_in, ndim_in)
        self.fc_edge = nn.Linear(ndim_in * 2, edim_out)
        self.relu = nn.ReLU()
        self.dropout = nn.Dropout(dropout_rate)
        self.agg_type: str = agg_type
        self.reset_parameters()

    def reset_parameters(self):
        gain = nn.init.calculate_gain("relu")
        nn.init.xavier_normal_(self.fc_neigh.weight, gain=gain)
        nn.init.xavier_normal_(self.fc_edge.weight, gain=gain)

    def message(self, edge_attr):  # type: ignore[override]
        """
        Copy edge features as messages.
        DGL equivalent: fn.copy_e("h", "m")
        """
        return edge_attr

    # NOTE: aggregation is delegated to MessagePassing's built-in implementation,
    # which honours the ``aggr`` passed to ``super().__init__(aggr=agg_type)``.
    # A previous version overrode ``aggregate()`` and hard-coded ``reduce="mean"``,
    # which silently ignored ``agg_type`` (it became a dead parameter). With the
    # override removed, ``agg_type`` ("mean"/"max"/"sum"/"min") is now respected.

    def forward(self, edge_index, edge_attr, edge_couples, num_nodes):
        """
        Aggregate edge features to nodes, then compute edge embeddings.

        Args:
            edge_index: Edge connectivity [2, num_edges]
            edge_attr: Edge features [num_edges, edim_in] - the actual input data
            edge_couples: Target edge pairs [batch_size, 2] - edges to embed
            num_nodes: Number of nodes in the graph

        Returns:
            edge_embeddings: [batch_size, edim_out] - final edge representations

        Process:
            1. Aggregate edge features to nodes (mean of incoming edges)
            2. Transform aggregated features: fc_neigh + ReLU
            3. For target edges: concat source & dest node embeddings
            4. Project to final edge embeddings: fc_edge + dropout
        """
        # Aggregate edge features to nodes (DGL: fn.copy_e + fn.mean)
        node_embeddings = self.propagate(  # type: ignore
            edge_index, edge_attr=edge_attr, size=(num_nodes, num_nodes)
        )
        # Transform aggregated features and activate
        node_embeddings = self.relu(self.fc_neigh(node_embeddings))

        # Compute edge embeddings from concatenated source and destination node embeddings
        edge_embeddings = self.fc_edge(
            torch.cat(
                [
                    node_embeddings[edge_couples[:, 0]],
                    node_embeddings[edge_couples[:, 1]],
                ],
                dim=1,
            )
        )
        return self.dropout(edge_embeddings)


class EnhancedSAGELayer(nn.Module):
    """Statistical graph encoder for the ``enhanced`` encoder type.

    The clean/label-aware training loops call this layer with the same
    signature as :class:`SAGELayer`, but the internal representation is richer:

    1. **Bidirectional statistical aggregation.** Incoming and outgoing edges
       are pooled separately with ``agg_type``, max, min, standard deviation,
       and log-degree statistics so node embeddings keep scale, extremes, and
       local variability.
    2. **Source/destination interaction.** Target edge embeddings combine
       source state, destination state, their absolute difference, and their
       elementwise product to preserve directional role information.
    """

    def __init__(self, ndim_in, edim_in, edim_out, agg_type="mean", dropout_rate=0.0):
        super().__init__()
        self.agg_type: str = agg_type
        # Per direction: agg_type, max, min, std, and one log-degree feature.
        self.fc_neigh = nn.Linear(edim_in * 8 + 2, ndim_in)
        self.fc_edge = nn.Linear(ndim_in * 4, edim_out)
        self.relu = nn.ReLU()
        self.dropout = nn.Dropout(dropout_rate)
        self.reset_parameters()

    def reset_parameters(self):
        gain = nn.init.calculate_gain("relu")
        nn.init.xavier_normal_(self.fc_neigh.weight, gain=gain)
        nn.init.xavier_normal_(self.fc_edge.weight, gain=gain)

    @staticmethod
    def _sanitize(values):
        return torch.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0)

    @staticmethod
    def _aggregate(edge_attr, index, num_nodes, reduce):
        pooled = scatter(edge_attr, index, dim=0, dim_size=num_nodes, reduce=reduce)
        return EnhancedSAGELayer._sanitize(pooled)

    @staticmethod
    def _degree(index, num_nodes, dtype, device):
        ones = torch.ones(index.size(0), dtype=dtype, device=device)
        degree = scatter(ones, index, dim=0, dim_size=num_nodes, reduce="sum")
        return torch.log1p(degree).unsqueeze(1)

    @staticmethod
    def _std(edge_attr, index, num_nodes):
        mean = EnhancedSAGELayer._aggregate(edge_attr, index, num_nodes, "mean")
        mean_sq = EnhancedSAGELayer._aggregate(
            edge_attr * edge_attr, index, num_nodes, "mean"
        )
        variance = torch.clamp(mean_sq - mean * mean, min=0.0)
        return EnhancedSAGELayer._sanitize(torch.sqrt(variance))

    def _directional_stats(self, edge_attr, index, num_nodes):
        primary = self._aggregate(edge_attr, index, num_nodes, self.agg_type)
        max_pool = self._aggregate(edge_attr, index, num_nodes, "max")
        min_pool = self._aggregate(edge_attr, index, num_nodes, "min")
        std_pool = self._std(edge_attr, index, num_nodes)
        log_degree = self._degree(index, num_nodes, edge_attr.dtype, edge_attr.device)
        return torch.cat([primary, max_pool, min_pool, std_pool, log_degree], dim=1)

    def forward(self, edge_index, edge_attr, edge_couples, num_nodes):
        """
        Aggregate incoming and outgoing edge statistics to nodes, then compute
        edge embeddings. Same I/O contract as :meth:`SAGELayer.forward`.

        Args:
            edge_index: Edge connectivity [2, num_edges]
            edge_attr: Edge features [num_edges, edim_in]
            edge_couples: Target edge pairs [batch_size, 2] - edges to embed
            num_nodes: Number of nodes in the graph

        Returns:
            edge_embeddings: [batch_size, edim_out]
        """
        src_idx, dst_idx = edge_index[0], edge_index[1]
        in_stats = self._directional_stats(edge_attr, dst_idx, num_nodes)
        out_stats = self._directional_stats(edge_attr, src_idx, num_nodes)

        node_embeddings = self.dropout(
            self.relu(self.fc_neigh(torch.cat([in_stats, out_stats], dim=1)))
        )
        src_embeddings = node_embeddings[edge_couples[:, 0]]
        dst_embeddings = node_embeddings[edge_couples[:, 1]]
        edge_pair = torch.cat(
            [
                src_embeddings,
                dst_embeddings,
                torch.abs(src_embeddings - dst_embeddings),
                src_embeddings * dst_embeddings,
            ],
            dim=1,
        )

        edge_embeddings = self.fc_edge(edge_pair)
        return self.dropout(edge_embeddings)


class LearnablePositionalEncoding(nn.Module):
    def __init__(self, embed_dim, max_len=512):
        super().__init__()
        self.pe = nn.Parameter(torch.zeros(max_len, embed_dim))
        nn.init.xavier_uniform_(self.pe)

    def forward(self, x):
        return x + self.pe[: x.size(1), :]


class SinusoidalPositionalEncoding(nn.Module):
    def __init__(self, embed_dim, max_len=512):
        super().__init__()

        pe = torch.zeros(max_len, embed_dim)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(
            torch.arange(0, embed_dim, 2).float()
            * (-torch.log(torch.tensor(10000.0)) / embed_dim)
        )
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer("pe", pe)

    def forward(self, x):
        return x + self.pe[: x.size(1), :]


class TransformerAutoencoder(nn.Module):
    def __init__(
        self,
        input_dim,
        embed_dim,
        num_heads,
        num_layers,
        dropout,
        window_size,
        positional_encoding,
        mask_ratio,
    ):
        super().__init__()
        if positional_encoding == "learnable":
            self.positional_encoder = LearnablePositionalEncoding(
                embed_dim, window_size
            )
        elif positional_encoding == "sinusoidal":
            self.positional_encoder = SinusoidalPositionalEncoding(
                embed_dim, window_size
            )
        else:
            self.positional_encoder = nn.Identity()
        self.input_projection = nn.Linear(input_dim, embed_dim)
        self.mask_ratio = mask_ratio
        self.encoder_layer = nn.TransformerEncoderLayer(
            d_model=embed_dim, nhead=num_heads, dropout=dropout, batch_first=True
        )
        self.encoder = nn.TransformerEncoder(self.encoder_layer, num_layers=num_layers)
        self.decoder_layer = nn.TransformerDecoderLayer(
            d_model=embed_dim, nhead=num_heads, dropout=dropout, batch_first=True
        )
        self.decoder = nn.TransformerDecoder(self.decoder_layer, num_layers=num_layers)
        self.output_projection = nn.Linear(embed_dim, input_dim)
        self._initialize_weights()

    def _initialize_weights(self):
        nn.init.xavier_uniform_(self.input_projection.weight)
        nn.init.zeros_(self.input_projection.bias)
        nn.init.xavier_uniform_(self.output_projection.weight)
        nn.init.zeros_(self.output_projection.bias)

        for name, param in self.encoder.named_parameters():
            if "weight" in name and param.dim() > 1:
                nn.init.xavier_uniform_(param)
            elif "bias" in name:
                nn.init.zeros_(param)

        for name, param in self.decoder.named_parameters():
            if "weight" in name and param.dim() > 1:
                nn.init.xavier_uniform_(param)
            elif "bias" in name:
                nn.init.zeros_(param)

    def forward(self, src, padding_mask=None):
        src = self.input_projection(src)

        # Identity function if no positional encoding is used
        src = self.positional_encoder(src)

        src_key_padding_mask = None
        if padding_mask is not None:
            if padding_mask.dtype != torch.bool:
                padding_mask = padding_mask.bool()
            src_key_padding_mask = ~torch.any(padding_mask, dim=-1)

        if self.training and self.mask_ratio > 0:
            seq_len = src.size(1)
            mask = torch.triu(
                torch.ones(seq_len, seq_len, device=src.device, dtype=torch.bool),
                diagonal=1,
            )
            mask = mask & (
                torch.rand(seq_len, seq_len, device=src.device) < self.mask_ratio
            )
            attention_mask = mask | mask.T
        else:
            attention_mask = None

        memory = self.encoder(
            src, mask=attention_mask, src_key_padding_mask=src_key_padding_mask
        )

        output = self.decoder(
            src,
            memory,
            memory_key_padding_mask=src_key_padding_mask,
            tgt_mask=attention_mask,
            tgt_key_padding_mask=src_key_padding_mask,
        )

        output = self.output_projection(output)
        return output


class NoGraphEncoder(nn.Module):
    """Flat MLP encoder — no graph structure, just source+dest edge features.

    This is the ablation baseline for GraphIDS: it replaces the E-GraphSAGE
    encoder with a simple linear projection, feeding edge features directly
    into the Transformer AE. The rest of the pipeline (training, LOE,
    evaluation) is identical.

    Signature matches SAGELayer.forward() so it's a drop-in replacement.
    """

    def __init__(self, edim_in, edim_out, dropout_rate=0.0):
        super().__init__()
        self.fc = nn.Sequential(
            nn.Linear(edim_in * 2, edim_out * 2),
            nn.ReLU(),
            nn.Dropout(dropout_rate),
            nn.Linear(edim_out * 2, edim_out),
        )
        self.reset_parameters()

    def reset_parameters(self):
        for layer in self.fc:
            if isinstance(layer, nn.Linear):
                nn.init.xavier_normal_(layer.weight, gain=nn.init.calculate_gain("relu"))
                nn.init.zeros_(layer.bias)

    def forward(self, edge_index, edge_attr, edge_couples, num_nodes):
        """Project src+dest edge features — ignore graph structure entirely."""
        del edge_index, num_nodes  # explicitly unused
        src_feat = edge_attr[edge_couples[:, 0]]
        dst_feat = edge_attr[edge_couples[:, 1]]
        return self.fc(torch.cat([src_feat, dst_feat], dim=1))


class PlainAE(nn.Module):
    """GraphIDS ablation: remove GNN, keep Transformer AE.

    Uses NoGraphEncoder to project raw edge features, then the same
    TransformerAutoencoder for masked reconstruction. Same save/load
    interface as TopInspect so trainers work unchanged.
    """

    def __init__(
        self,
        ndim_in,
        edim_in,
        edim_out,
        embed_dim,
        num_heads,
        num_layers,
        window_size=512,
        dropout=0.0,
        ae_dropout=0.1,
        positional_encoding=None,
        agg_type="mean",
        mask_ratio=0.15,
        encoder_type="baseline",
    ):
        super().__init__()
        # encoder_type is ignored — NoGraphEncoder has no variants
        del encoder_type, agg_type, ndim_in
        self.encoder = NoGraphEncoder(edim_in, edim_out, dropout)
        self.transformer = TransformerAutoencoder(
            edim_out,
            embed_dim,
            num_heads,
            num_layers,
            ae_dropout,
            window_size,
            positional_encoding,
            mask_ratio,
        )

    def save_checkpoint(self, path, optimizer=None, epoch=0, threshold=None):
        checkpoint = {
            "model_state_dict": self.state_dict(),
            "epoch": epoch,
            "threshold": threshold,
        }
        if optimizer:
            checkpoint["optimizer_state_dict"] = optimizer.state_dict()
        torch.save(checkpoint, path)

    def load_checkpoint(self, path, optimizer=None):
        checkpoint = torch.load(path, weights_only=True)
        self.load_state_dict(checkpoint["model_state_dict"])
        if optimizer and "optimizer_state_dict" in checkpoint:
            optimizer.load_state_dict(checkpoint["optimizer_state_dict"])
        return checkpoint["epoch"], checkpoint["threshold"]


class TopInspect(nn.Module):
    def __init__(
        self,
        ndim_in,
        edim_in,
        edim_out,
        embed_dim,
        num_heads,
        num_layers,
        window_size=512,
        dropout=0.0,
        ae_dropout=0.1,
        positional_encoding=None,
        agg_type="mean",
        mask_ratio=0.15,
        encoder_type="baseline",
    ):
        super().__init__()
        # NOTE on node dimensions: the dataset builds placeholder node features
        # ``x = torch.ones(num_nodes, edim_in)`` (see utils/dataloaders.py), so
        # ``ndim_in == edim_in`` in practice. Neither encoder reads the initial
        # ``x`` — node representations are produced purely by aggregating edge
        # features. ``ndim_in`` therefore only sets the width of ``fc_neigh``'s
        # output (the intermediate node-embedding size), not an input feature
        # count. It is kept as an explicit argument for clarity and tunability.
        if encoder_type == "enhanced":
            self.encoder = EnhancedSAGELayer(
                ndim_in, edim_in, edim_out, agg_type, dropout
            )
        elif encoder_type == "baseline":
            self.encoder = SAGELayer(ndim_in, edim_in, edim_out, agg_type, dropout)
        else:
            raise ValueError("encoder_type must be one of: baseline, enhanced")
        self.transformer = TransformerAutoencoder(
            edim_out,
            embed_dim,
            num_heads,
            num_layers,
            ae_dropout,
            window_size,
            positional_encoding,
            mask_ratio,
        )

    def save_checkpoint(self, path, optimizer=None, epoch=0, threshold=None):
        checkpoint = {
            "model_state_dict": self.state_dict(),
            "epoch": epoch,
            "threshold": threshold,
        }
        if optimizer:
            checkpoint["optimizer_state_dict"] = optimizer.state_dict()
        torch.save(checkpoint, path)

    def load_checkpoint(self, path, optimizer=None):
        checkpoint = torch.load(path, weights_only=True)
        self.load_state_dict(checkpoint["model_state_dict"])
        if optimizer and "optimizer_state_dict" in checkpoint:
            optimizer.load_state_dict(checkpoint["optimizer_state_dict"])
        return checkpoint["epoch"], checkpoint["threshold"]
