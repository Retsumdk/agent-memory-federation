# Agent Memory Federation

A distributed system enabling AI agents across different platforms to share and synchronize memory stores while maintaining data sovereignty.

## Problem

In multi-agent systems, each agent maintains its own isolated memory store. This creates knowledge silos:
- Agents cannot leverage learned context from other agents
- Duplicated effort in learning similar concepts
- No shared understanding across agent teams

## Solution

Agent Memory Federation implements a federated architecture where:
- Each agent retains ownership of its memory
- Selective memory sharing via configurable sync policies
- Vector-based semantic search across federated stores
- Conflict resolution with CRDT-style eventual consistency
- Differential privacy controls for sensitive data

## Features

- **Federated Sync Protocol**: Secure peer-to-peer memory synchronization
- **Semantic Search**: Cross-agent vector similarity search
- **Access Control**: Fine-grained memory sharing policies
- **Conflict Resolution**: Automatic merge with conflict detection
- **Privacy Controls**: Differential privacy and data masking

## Quick Start

```typescript
import { FederationClient, SyncPolicy } from './src/index';

// Create federation client
const client = new FederationClient({
  agentId: 'agent-001',
  syncPolicy: SyncPolicy.BIDIRECTIONAL,
});

// Connect to federation network
await client.connect('federation-seed-node:8080');

// Search memories across all federated agents
const results = await client.federatedSearch('best practices for API design', {
  limit: 10,
  privacyLevel: 'strict',
});

// Sync specific memory to other agents
await client.shareMemory(memoryId, ['agent-002', 'agent-003']);
```

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Agent A   │◄───►│   Agent B   │◄───►│   Agent C   │
│  Memory A   │     │  Memory B   │     │  Memory C   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│              Federation Control Plane                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │  Sync   │  │ Search  │  │ Privacy │  │ Conflict│   │
│  │ Manager │  │ Engine  │  │ Engine  │  │Resolver │   │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Configuration

```typescript
interface FederationConfig {
  // Agent identification
  agentId: string;
  agentName: string;
  
  // Network settings
  seedNodes: string[];
  port: number;
  
  // Sync behavior
  syncPolicy: SyncPolicy; // BIDIRECTIONAL, ONE_WAY, MANUAL
  syncIntervalMs: number;
  
  // Memory settings
  maxMemorySize: number;
  vectorDimension: number;
  
  // Privacy
  privacyLevel: 'strict' | 'balanced' | 'open';
  allowedPeers: string[];
}
```

## API

### FederationClient

| Method | Description |
|--------|-------------|
| `connect(seedNode)` | Connect to federation network |
| `disconnect()` | Disconnect from network |
| `federatedSearch(query, options)` | Search across all agents |
| `shareMemory(memoryId, agents)` | Share specific memory |
| `subscribeToUpdates(callback)` | Subscribe to memory updates |

### MemoryStore

| Method | Description |
|--------|-------------|
| `store(memory)` | Store new memory |
| `retrieve(id)` | Get memory by ID |
| `search(query, options)` | Local semantic search |
| `export()` | Export memory as JSON |

## License

MIT
