from torch import nn
import torch

class ECALayer(nn.Module):
    """Constructs a ECA module.
    Args:
        channel: Number of channels of the input feature map
        k_size: Adaptive selection of kernel size
    """
    def __init__(self, channel, k_size=3):
        super(ECALayer, self).__init__()
        self.avg_pool = nn.AdaptiveAvgPool2d(1)
        self.conv = nn.Conv1d(1, 1, kernel_size=k_size, padding=(k_size - 1) // 2, bias=False)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x):
        _, _, w, h = x.size()
        w = int(w / 2)
        h = int(h / 2)
##########################################################################
        q1 = torch.split(x, w, dim=2)
        q2 = [2][len(q1)]
        for i in range(0, len(q1)):
            q2[i] = torch.split(q1[i], h, dim=3)

        quarter_attention = [len(q1) * len(q1)]
        q_num = 0
        for i in range(0,len(q2)):
            for j in range(0,len(q2[0])):
                quarter_attention[q_num] = self.avg_pool(q2[i][j])
                q_num += 1
        # # shuffle打乱
        # idx = torch.randperm(quarter_attention.shape[1])
        # quarter_attention = quarter_attention[:, idx].view(quarter_attention.size())

        channel_attention = []
        for c in quarter_attention:
            channel_attention = torch.cat([channel_attention, c], dim=1)

        # shuffle打乱
        idx = torch.randperm(channel_attention.shape[1])
        channel_attention = channel_attention[:, idx].view(channel_attention.size())

        b, c, _, _ = channel_attention.size()
        n = len(channel_attention)
        channel_attention = nn.Conv2d(in_channels=n, out_channels=int(n/4),kernel_size=1,stride=1, padding=0)



###########################################################################
        # Two different branches of ECA module
        y = self.conv(y.squeeze(-1).transpose(-1, -2))
        y = y.transpose(-1, -2).unsqueeze(-1)

        # Multi-scale information fusion
        y = self.sigmoid(y)

        c = int(c / 4)
        y = y.view(b, c, 4, 1, 1)

        y = torch.mean(y, dim=2)

        return x * y.expand_as(x)