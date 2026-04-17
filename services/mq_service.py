import json
import logging

from scripts.mq_comparison import compare_mq_definitions


def compare_definitions(source_json: str, destination_json: str) -> dict:
    logging.info("Comparing MQ definitions")
    source_definition = json.loads(source_json)
    destination_definition = json.loads(destination_json)
    return compare_mq_definitions(source_definition, destination_definition)
