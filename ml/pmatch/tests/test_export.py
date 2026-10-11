import base64

import numpy as np
import torch

from pmatch import export, parity
from pmatch.model import ParticleWorldModel, Settings
from pmatch.nets import AudioTCN, ParticleFlow


def small_model() -> ParticleWorldModel:
    generator = torch.Generator().manual_seed(9)
    network = AudioTCN(16, 8, 3, (1, 2), 3, 0.0)
    with torch.no_grad():
        for p in network.parameters():
            p.copy_(0.2 * torch.randn(p.shape, generator=generator))
    settings = Settings(1.0, 2.0, 0.1, 0.2, 100.0, 5.0, (0.03, 0.02, 0.04, 0.04, 0.04), None, {"name": "t"}, {"framework": "pytorch"}, {})
    return ParticleWorldModel(
        network,
        ParticleFlow(8, 2, 4, 16),
        torch.rand(2, 32, 32, generator=generator),
        torch.rand(2, 3, generator=generator),
        torch.rand(32, generator=generator),
        torch.randn(10, 8, generator=generator),
        torch.randint(2, (10,), generator=generator),
        settings,
    )


def test_an_exported_model_reads_back_with_the_same_numbers():
    fixture = parity.fixture()
    model = export.decode(base64.b64decode(fixture["model"]))
    arrays = {k: export.unpack(v) for k, v in fixture["arrays"].items()}
    assert np.array_equal(model["prototypes"], arrays["prototypes"])
    assert np.array_equal(model["sprites"]["data"], arrays["spriteData"])
    assert model["trainer"]["framework"] == "pytorch"
    d = model["dynamics"]
    c, i, k, o = d["channels"], d["inputs"], d["kernel"], d["outputs"]
    assert len(d["weights"]) == c * i + c + len(d["dilations"]) * (c * c * k + c + c * c + c) + o * c + o + o * i
    assert model["prototypes"].size == 64 * export.PROTO_STRIDE


def test_a_checkpoint_restores_the_same_model():
    model = small_model()
    restored = ParticleWorldModel.from_checkpoint(model.checkpoint())
    assert restored.encode() == model.encode()
    assert torch.equal(restored.dynamics.flat_weights(), model.dynamics.flat_weights())
