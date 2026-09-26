"""Recovery policy/PCM retention contract; no audio is persisted or sent to a provider."""
import pytest

from audiohelper.native_recovery import RecoveryBudget, ReplayBuffer


def test_only_unconfirmed_pcm_is_replayed_and_clear_releases_it() -> None:
    buffer = ReplayBuffer(8000, start_sample=100)
    buffer.append(b'\x01\x00' * 80)
    buffer.confirm(130)
    assert buffer.start == 130 and buffer.end == 180
    assert buffer.read(130) == b'\x01\x00' * 50
    buffer.clear()
    assert buffer.size_bytes == 0
    assert buffer.read(180) == b''


def test_buffer_never_exceeds_thirty_seconds() -> None:
    buffer = ReplayBuffer(8000)
    for _ in range(60):
        buffer.append(b'\x00\x00' * 4000)
    assert buffer.size_bytes == 480000
    with pytest.raises(BufferError):
        buffer.append(b'\x00\x00')
    assert buffer.size_bytes == 480000


def test_retry_budget_does_not_reset_on_a_flapping_connection() -> None:
    budget = RecoveryBudget()
    assert budget.next_delay() == 0
    assert budget.next_delay() == 2
    budget.connected(10)
    budget.disconnected(39)
    assert budget.next_delay() == 5
    with pytest.raises(TimeoutError):
        budget.next_delay()
    budget.connected(40)
    budget.disconnected(70)
    assert budget.next_delay() == 0
