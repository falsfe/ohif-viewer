from typing import Callable, Dict, Any

AlgorithmFn = Callable[[str, str, Dict[str, Any]], Dict[str, Any]]

_registry: Dict[str, Dict[str, Any]] = {}


def register(algorithm_id: str, name: str, description: str, fn: AlgorithmFn):
    _registry[algorithm_id] = {
        "id": algorithm_id,
        "name": name,
        "description": description,
        "fn": fn,
    }


def get(algorithm_id: str):
    return _registry.get(algorithm_id)


def list_all():
    return [{"id": v["id"], "name": v["name"], "description": v["description"]} for v in _registry.values()]


from algorithms import mock_seg  # noqa: E402, F401
