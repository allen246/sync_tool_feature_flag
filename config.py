
import logging, os

class Config:
    DEBUG = os.environ.get("DEBUG", "false").lower() == "true"
    HOST = os.environ.get("HOST", "0.0.0.0")
    PORT = int(os.environ.get("PORT", "5000"))
    LOG_FILE = os.environ.get("LOG_FILE", os.path.join("logs", "app.log"))

def configure_logging(app):
    os.makedirs("logs",exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        handlers=[
            logging.FileHandler(Config.LOG_FILE),
            logging.StreamHandler()
        ]
    )
    app.logger.info("Logging initialized")
