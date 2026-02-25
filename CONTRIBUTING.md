# Contributing to PayGate MCP

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/walker77/paygate-mcp.git
cd paygate-mcp
npm install
npm test        # Run all 193 tests
npm run build   # Compile TypeScript
```

## Running Tests

```bash
npm test                    # All tests
npx jest tests/store.test   # Single file
npx jest --verbose          # Detailed output
```

## Project Structure

```
src/
  cli.ts          # CLI entry point (--server, --remote-url, --price, etc.)
  server.ts       # HTTP server with admin REST API
  proxy.ts        # JSON-RPC proxy to wrapped MCP server (stdio transport)
  http-proxy.ts   # JSON-RPC proxy to remote MCP server (Streamable HTTP)
  stripe.ts       # Stripe webhook handler for auto credit top-up
  gate.ts         # Auth + billing + rate limit evaluation
  store.ts        # API key storage (in-memory + optional file persistence)
  rate-limiter.ts # Sliding window rate limiter
  meter.ts        # Usage metering and analytics
  types.ts        # Shared TypeScript types
  index.ts        # Public API exports

tests/
  *.test.ts       # Unit tests
  e2e/            # End-to-end and red-team security tests
```

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add tests for new functionality
4. Run `npm test` and ensure all tests pass
5. Run `npm run build` to check TypeScript compiles
6. Open a pull request

## Reporting Issues

Open an issue at https://github.com/walker77/paygate-mcp/issues with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Node.js version and OS

## Code Style

- TypeScript strict mode
- No external runtime dependencies (zero-dep is a feature)
- Every new feature needs tests
- Security-sensitive code needs red-team tests
