# Architecture

## System Overview

PeerCortex is an MCP (Model Context Protocol) server that acts as a unified interface between AI assistants and multiple network intelligence data sources.

```
┌──────────────────────────────────────────────────────────────────┐
│                        MCP Client Layer                          │
│        (Claude Code / Claude Desktop / Any MCP Client)           │
└──────────────────────────┬───────────────────────────────────────┘
                           │ MCP Protocol (stdio / SSE)
┌──────────────────────────▼───────────────────────────────────────┐
│                     PeerCortex MCP Server                         │
│                                                                   │
│  ┌─────────┐ ┌─────────┐ ┌─────┐ ┌──────┐ ┌────────┐ ┌───────┐ │
│  │ lookup  │ │ peering │ │ bgp │ │ rpki │ │compare │ │report │ │
│  └────┬────┘ └────┬────┘ └──┬──┘ └──┬───┘ └───┬────┘ └───┬───┘ │
│       │           │         │       │          │          │      │
│  ┌────▼───────────▼─────────▼───────▼──────────▼──────────▼───┐  │
│  │                    Source Aggregation Layer                  │  │
│  └────┬───────┬────────┬────────┬────────┬─────────┬──────────┘  │
│       │       │        │        │        │         │             │
│  ┌────▼──┐┌───▼───┐┌───▼──┐┌───▼───┐┌───▼──┐┌────▼────┐       │
│  │Peering││RIPE   ││bgp.  ││Route  ││IRR / ││RPKI     │       │
│  │DB     ││Stat   ││he.net││Views  ││WHOIS ││Validator│       │
│  └───────┘└───────┘└──────┘└───────┘└──────┘└─────────┘       │
│                                                                   │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐   │
│  │   SQLite Cache      │  │   Ollama (Local AI)              │   │
│  │   (API Responses)   │  │   (Analysis & Report Generation) │   │
│  └─────────────────────┘  └──────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

## Component Details

### MCP Server (`src/mcp-server/`)

The server exposes 6 tools via the Model Context Protocol:

| Tool | Purpose | Primary Sources |
|------|---------|----------------|
| `lookup` | ASN / Prefix / IX lookups | PeeringDB, RIPE Stat, bgp.he.net, IRR, RPKI |
| `peering` | Peering partner discovery | PeeringDB, Ollama |
| `bgp` | BGP analysis & anomaly detection | RIPE Stat, Route Views, bgp.he.net |
| `rpki` | RPKI validation & compliance | Routinator, RIPE RPKI, RIPE Stat |
| `compare` | Network comparison | PeeringDB, RIPE Stat, RPKI |
| `report` | Report generation | All sources + Ollama |

### Data Sources (`src/sources/`)

Each source module implements a consistent client interface:

- **PeeringDB** (`peeringdb.ts`): RESTful API v2 with optional API key auth
- **RIPE Stat** (`ripe-stat.ts`): Data calls API for routing and resource info
- **bgp.he.net** (`bgp-he.ts`): HTML scraping (no official API available)
- **Route Views** (`route-views.ts`): Via RIPE Stat RIS data calls
- **IRR** (`irr.ts`): RIPE DB REST API + WHOIS protocol
- **RPKI** (`rpki.ts`): Routinator API with RIPE RPKI fallback

### AI Layer (`src/ai/`)

- **Ollama Client**: Interfaces with local Ollama instance
- **Prompt Templates**: Specialized prompts for each analysis type
- All inference runs locally — no data leaves the machine

### Cache Layer (`src/cache/`)

- SQLite-backed with WAL mode for performance
- TTL-based expiration per entry
- Source-level invalidation support
- Reduces API calls and improves response times

## Data Flow

1. MCP client sends a tool invocation (e.g., `lookup` with ASN=13335)
2. Tool handler validates input using Zod schemas
3. Cache is checked for fresh data
4. Source clients query external APIs in parallel
5. Results are merged, cached, and optionally analyzed by Ollama
6. Structured response is returned via MCP protocol

## Security Model

- No data is sent to cloud AI services (Ollama runs locally)
- API keys are stored in environment variables, never in code
- PeeringDB API key is optional (works without auth at lower rate limits)
- Cache database is local SQLite — no external database dependencies
