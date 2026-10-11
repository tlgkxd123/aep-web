import numpy as np
import torch

from pmatch.generator import FlowOptions, train_flow
from pmatch.nets import AudioTCN, ParticleFlow


def randomize(module: torch.nn.Module, scale: float, seed: int) -> None:
    generator = torch.Generator().manual_seed(seed)
    with torch.no_grad():
        for p in module.parameters():
            p.copy_(scale * torch.randn(p.shape, generator=generator, dtype=p.dtype))


def ks(a: np.ndarray, b: np.ndarray) -> float:
    a, b = np.sort(a), np.sort(b)
    grid = np.concatenate([a, b])
    return float(np.max(np.abs(np.searchsorted(a, grid, side="right") / len(a) - np.searchsorted(b, grid, side="right") / len(b))))


def test_flow_inverts_with_the_log_determinant_of_its_jacobian():
    flow = ParticleFlow(8, 3, layers=8, hidden=32).double()
    randomize(flow, 0.3, 1)
    x = torch.randn(6, 8, dtype=torch.float64, generator=torch.Generator().manual_seed(2))
    z, logdet = flow.to_latent(x)
    assert torch.allclose(flow.from_latent(z), x, atol=1e-10)
    for i in range(len(x)):
        jacobian = torch.autograd.functional.jacobian(lambda v: flow.to_latent(v[None])[0][0], x[i])
        assert abs(torch.linalg.slogdet(jacobian).logabsdet.item() - logdet[i].item()) < 1e-9


def test_flow_samples_follow_the_distribution_it_learned():
    rng = np.random.default_rng(3)
    n = 20000
    base = rng.normal(size=n)
    data = np.stack([base, 0.5 * base + 0.3 * rng.normal(size=n), np.exp(0.5 * rng.normal(size=n)), rng.uniform(-1, 1, size=n)], 1)
    states = torch.as_tensor(data, dtype=torch.float32)
    result = train_flow(states, torch.zeros(n, dtype=torch.long), 1, FlowOptions(steps=3000, mirror=False, hidden=64), seed=4)
    drawn, _ = result.flow.sample(n, torch.Generator().manual_seed(5))
    for d in range(data.shape[1]):
        assert ks(drawn[:, d].numpy(), data[:, d]) < 0.05, f"dimension {d}"
    drawn_corr = np.corrcoef(drawn[:, 0].numpy(), drawn[:, 1].numpy())[0, 1]
    assert abs(drawn_corr - np.corrcoef(data[:, 0], data[:, 1])[0, 1]) < 0.05


def test_tcn_keeps_the_length_and_reaches_exactly_its_receptive_field():
    network = AudioTCN(16, 8, 3, (1, 2, 4), 3, 0.0).double().eval()
    randomize(network, 0.4, 6)
    assert network.receptive_field == 15
    quiet = torch.zeros(1, 16, 101, dtype=torch.float64)
    impulse = quiet.clone()
    impulse[0, :, 50] = 1.0
    with torch.no_grad():
        change = (network(impulse) - network(quiet)).abs().sum(1)[0]
    assert network(quiet).shape == (1, 3, 101)
    reached = torch.nonzero(change > 1e-12).flatten()
    assert int(reached.min()) == 50 - 7 and int(reached.max()) == 50 + 7
