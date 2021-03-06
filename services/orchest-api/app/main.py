from app import create_app
from config import CONFIG_CLASS

app = create_app(config_class=CONFIG_CLASS, be_scheduler=True)

if __name__ == "__main__":
    app.run(host="0.0.0.0")
