# UNEAKBEATZ Studio

Type a description, get a finished song with beat and vocals. Free and unlimited: the music is made on your own computer by [ACE-Step 1.5](https://github.com/ACE-Step/ACE-Step-1.5), an open-source song model. No accounts, no API keys.

## What you need

- A computer with a graphics card with 6 GB or more of video memory (NVIDIA recommended), or an Apple Silicon Mac (M1 or newer). It can run without one, but very slowly.
- About 10 GB of free disk space for the model, downloaded automatically the first time.
- [Node.js](https://nodejs.org) 20 or newer.

## Setup

### 1. Start the music engine (ACE-Step)

**Windows (NVIDIA card):** download and extract https://files.acemusic.ai/acemusic/win/ACE-Step-1.5.7z, then double-click `start_api_server.bat`.

**Mac (Apple Silicon):** download and extract https://files.acemusic.ai/acemusic/mac/ACE-Step-1.5.zip, then in Terminal, inside that folder:

    chmod +x start_api_server_macos.sh
    ./start_api_server_macos.sh

**Linux, or from source on any system** (needs git and [uv](https://docs.astral.sh/uv/)):

    git clone https://github.com/ACE-Step/ACE-Step-1.5.git
    cd ACE-Step-1.5
    uv sync
    uv run acestep-api

Leave that window open. The first start downloads the model, which takes a while.

### 2. Start the studio

In this folder:

    npm start

Then open http://localhost:3000. A yellow banner at the top means the studio can't reach the engine yet.

## Using it

- Describe the song (genre, mood, tempo, instruments, voice, topic), pick a length, and press **Generate song**.
- Leave **Lyrics** blank and the AI writes them, or type your own with section tags like `[Verse 1]`, `[Chorus]`, `[Bridge]`.
- Finished songs appear under **Your songs** with a player, the lyrics, an MP3 download, and **Reuse prompt** to tweak and regenerate. Files are kept in the `songs/` folder.

## Settings

Optional. Copy `.env.example` to `.env` to change the studio's port or point it at an engine on another address (`ACESTEP_URL`).

## Notes

ACE-Step's code is MIT licensed. Before releasing songs commercially, check the model's license on its [Hugging Face page](https://huggingface.co/ACE-Step/Ace-Step1.5) and the rules of your distributor about AI-generated music.
