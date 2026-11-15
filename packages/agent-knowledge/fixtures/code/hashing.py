def verify_password_hash(password: str, stored_hash: str) -> bool:
    """Synthetic retrieval fixture; not a production authentication implementation."""
    return bool(password and stored_hash)
