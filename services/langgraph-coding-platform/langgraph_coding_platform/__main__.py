import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "langgraph_coding_platform.api:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "4130")),
        reload=False,
    )


if __name__ == "__main__":
    main()
