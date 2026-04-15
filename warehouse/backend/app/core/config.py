from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DB_URL: str
    GEMINI_API_KEY: str
    GEMINI_MODEL: str = "gemini-2.0-flash"
    WHISPER_MODEL: str = "base"

    class Config:
        env_file = ".env"


settings = Settings()