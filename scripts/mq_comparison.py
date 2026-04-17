import json
from collections import defaultdict
from typing import Any


Definition = dict[str, Any]
Resource = dict[str, Any]


def _as_list(definition: Definition, key: str) -> list[Resource]:
    value = definition.get(key, [])
    return value if isinstance(value, list) else []


def _canonical(value: Any) -> str:
    return json.dumps(value or {}, sort_keys=True, separators=(",", ":"), default=str)


def _queue_key(queue: Resource) -> tuple[str, str]:
    return queue.get("vhost", "/"), queue.get("name", "")


def _exchange_key(exchange: Resource) -> tuple[str, str]:
    return exchange.get("vhost", "/"), exchange.get("name", "")


def _binding_identity(binding: Resource) -> tuple[str, str, str, str, str, str]:
    return (
        binding.get("vhost", "/"),
        binding.get("source", ""),
        binding.get("destination", ""),
        binding.get("destination_type", ""),
        binding.get("routing_key", ""),
        _canonical(binding.get("arguments")),
    )


def _index_by_key(resources: list[Resource], key_func) -> dict[tuple[Any, ...], Resource]:
    return {key_func(resource): resource for resource in resources}


def _sort_by_name(resources: list[Resource]) -> list[Resource]:
    return sorted(resources, key=lambda item: (item.get("vhost", "/"), item.get("name", "")))


def _sort_bindings(bindings: list[Resource]) -> list[Resource]:
    return sorted(
        bindings,
        key=lambda item: (
            item.get("vhost", "/"),
            item.get("source", ""),
            item.get("destination", ""),
            item.get("routing_key", ""),
            _canonical(item.get("arguments")),
        ),
    )


def _bindings_by_queue(bindings: list[Resource]) -> dict[tuple[str, str], list[Resource]]:
    grouped: dict[tuple[str, str], list[Resource]] = defaultdict(list)
    for binding in bindings:
        if binding.get("destination_type") != "queue":
            continue
        grouped[(binding.get("vhost", "/"), binding.get("destination", ""))].append(binding)
    return grouped


def _build_queue_reports(
    queues: list[Resource],
    queue_bindings: dict[tuple[str, str], list[Resource]],
    exchanges_by_key: dict[tuple[str, str], Resource],
) -> list[dict[str, Any]]:
    reports = []
    for queue in _sort_by_name(queues):
        bindings = _sort_bindings(queue_bindings.get(_queue_key(queue), []))
        exchange_keys = {
            (binding.get("vhost", "/"), binding.get("source", ""))
            for binding in bindings
            if binding.get("source")
        }
        exchanges = _sort_by_name(
            [
                exchanges_by_key[exchange_key]
                for exchange_key in exchange_keys
                if exchange_key in exchanges_by_key
            ]
        )
        reports.append(
            {
                "queue": queue,
                "bindings": bindings,
                "exchanges": exchanges,
            }
        )
    return reports


def compare_mq_definitions(source_definition: Definition, destination_definition: Definition) -> dict[str, Any]:
    """
    Compare two RabbitMQ definition exports.

    The main migration view is source-to-destination: queues, exchanges and
    bindings present in source but missing in destination. The reverse
    direction is also returned so the UI can show destination-only drift.
    """
    if not isinstance(source_definition, dict) or not isinstance(destination_definition, dict):
        raise ValueError("Both Source and Destination inputs must be RabbitMQ definition JSON objects.")

    source_queues = _as_list(source_definition, "queues")
    destination_queues = _as_list(destination_definition, "queues")
    source_exchanges = _as_list(source_definition, "exchanges")
    destination_exchanges = _as_list(destination_definition, "exchanges")
    source_bindings = _as_list(source_definition, "bindings")
    destination_bindings = _as_list(destination_definition, "bindings")

    source_queues_by_key = _index_by_key(source_queues, _queue_key)
    destination_queues_by_key = _index_by_key(destination_queues, _queue_key)
    source_exchanges_by_key = _index_by_key(source_exchanges, _exchange_key)
    destination_exchanges_by_key = _index_by_key(destination_exchanges, _exchange_key)
    source_bindings_by_key = _index_by_key(source_bindings, _binding_identity)
    destination_bindings_by_key = _index_by_key(destination_bindings, _binding_identity)

    missing_queue_keys = sorted(set(source_queues_by_key) - set(destination_queues_by_key))
    destination_only_queue_keys = sorted(set(destination_queues_by_key) - set(source_queues_by_key))
    missing_exchange_keys = sorted(set(source_exchanges_by_key) - set(destination_exchanges_by_key))
    destination_only_exchange_keys = sorted(set(destination_exchanges_by_key) - set(source_exchanges_by_key))
    missing_binding_keys = sorted(set(source_bindings_by_key) - set(destination_bindings_by_key))
    destination_only_binding_keys = sorted(set(destination_bindings_by_key) - set(source_bindings_by_key))

    source_bindings_by_queue = _bindings_by_queue(source_bindings)
    destination_bindings_by_queue = _bindings_by_queue(destination_bindings)

    missing_queues = _build_queue_reports(
        [source_queues_by_key[key] for key in missing_queue_keys],
        source_bindings_by_queue,
        source_exchanges_by_key,
    )
    destination_only_queues = _build_queue_reports(
        [destination_queues_by_key[key] for key in destination_only_queue_keys],
        destination_bindings_by_queue,
        destination_exchanges_by_key,
    )

    result = {
        "summary": {
            "source": {
                "queues": len(source_queues),
                "exchanges": len(source_exchanges),
                "bindings": len(source_bindings),
            },
            "destination": {
                "queues": len(destination_queues),
                "exchanges": len(destination_exchanges),
                "bindings": len(destination_bindings),
            },
            "missing_in_destination": {
                "queues": len(missing_queue_keys),
                "exchanges": len(missing_exchange_keys),
                "bindings": len(missing_binding_keys),
            },
            "only_in_destination": {
                "queues": len(destination_only_queue_keys),
                "exchanges": len(destination_only_exchange_keys),
                "bindings": len(destination_only_binding_keys),
            },
        },
        "missing_in_destination": {
            "queues": missing_queues,
            "exchanges": _sort_by_name([source_exchanges_by_key[key] for key in missing_exchange_keys]),
            "bindings": _sort_bindings([source_bindings_by_key[key] for key in missing_binding_keys]),
        },
        "only_in_destination": {
            "queues": destination_only_queues,
            "exchanges": _sort_by_name([destination_exchanges_by_key[key] for key in destination_only_exchange_keys]),
            "bindings": _sort_bindings([destination_bindings_by_key[key] for key in destination_only_binding_keys]),
        },
    }
    result["has_differences"] = any(
        count
        for group in ("missing_in_destination", "only_in_destination")
        for count in result["summary"][group].values()
    )
    return result


def compare_mq_json(source_json: str, destination_json: str) -> dict[str, Any]:
    source_definition = json.loads(source_json)
    destination_definition = json.loads(destination_json)
    return compare_mq_definitions(source_definition, destination_definition)


if __name__ == "__main__":
    source_file = input("Enter Source RabbitMQ definition JSON file path: ").strip()
    destination_file = input("Enter Destination RabbitMQ definition JSON file path: ").strip()
    with open(source_file, "r") as source, open(destination_file, "r") as destination:
        comparison = compare_mq_definitions(json.load(source), json.load(destination))
    print(json.dumps(comparison, indent=2))
