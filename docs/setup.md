# Setup Guide

## Prerequisites

- **Node.js** 20+ (LTS recommended)
- **Ollama** installed and running locally
- **Docker** (optional, for containerized deployment)

## Quick Start

### 1. Install Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Pull a recommended model
ollama pull llama3.1
```

### 2. Install PeerCortex

```bash
# Clone the repository
git clone https://github.com/peercortex/peercortex.git
cd peercortex

# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Build
npm run build

# Start the MCP server
npm start
```

### 3. Configure Claude Code

Add PeerCortex to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "peercortex": {
      "command": "node",
      "args": ["/path/to/peercortex/dist/mcp-server/index.js"],
      "env": {
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "llama3.1"
      }
    }
  }
}
```

### 4. Docker Setup (Alternative)

```bash
# Start PeerCortex with Ollama
docker compose up -d

# Pull the AI model inside the Ollama container
docker exec peercortex-ollama ollama pull llama3.1
```

## Configuration Reference

See `.env.example` for all available configuration options.

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `llama3.1` | LLM model for analysis |
| `PEERINGDB_API_KEY` | _(empty)_ | Optional PeeringDB API key |
| `RIPE_STAT_SOURCE_APP` | `peercortex` | RIPE Stat source app identifier |
| `ROUTINATOR_URL` | `http://localhost:8323` | Routinator RPKI validator URL |
| `CACHE_DB_PATH` | `./peercortex-cache.db` | SQLite cache file path |
| `CACHE_TTL_SECONDS` | `3600` | Default cache TTL |
| `MCP_TRANSPORT` | `stdio` | Transport protocol (stdio/sse) |
| `LOG_LEVEL` | `info` | Logging level |

## Optional: PeeringDB API Key

PeerCortex works without a PeeringDB API key, but you'll hit rate limits faster.
To get a free API key:

1. Create an account at [peeringdb.com](https://www.peeringdb.com/)
2. Go to your profile settings
3. Generate an API key
4. Add it to your `.env` file

## Optional: Local RPKI Validator

For faster RPKI validation, run Routinator locally:

```bash
# Via Docker
docker run -d --name routinator -p 8323:8323 nlnetlabs/routinator

# Or uncomment the routinator service in docker-compose.yml
```
