package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// getDashboardInput is get_dashboard's own argument shape — the same
// ?owner= query parameter handleDashboard already accepts, since a shared
// dashboard is reachable the same way from either transport.
type getDashboardInput struct {
	Owner string `json:"owner,omitempty" jsonschema:"a username whose dashboard to fetch, if that user has shared their dashboard with you from Settings -- omitted or empty for your own dashboard"`
}

// newMCPHandler returns an http.Handler serving the MCP Streamable HTTP
// transport (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports#streamable-http)
// at whatever path server.go mounts it under. It's meant to sit behind
// auth.RequireAuth the same way every other /api/* handler in this
// package does -- getServer below reads the *auth.User RequireAuth put in
// r's context and builds a fresh *mcp.Server with tool handlers closed
// over that specific user, the same "authenticated the same way the
// frontend already is" contract #561 asked for. No new auth mechanism:
// an MCP client authenticates with this app's own personal API tokens
// (Authorization: Bearer <token>, /api/tokens) exactly as a script hitting
// /api/dashboard directly already would.
func newMCPHandler(deps Deps) http.Handler {
	getServer := func(r *http.Request) *mcp.Server {
		// RequireAuth always sets this before the request ever reaches
		// here -- see handleDashboard's own identical comment. A request
		// that somehow got here without it gets a server whose only tool
		// always fails closed, rather than a nil-pointer panic.
		u, ok := auth.UserFromContext(r.Context())

		server := mcp.NewServer(&mcp.Implementation{Name: "forge-dashboard", Version: deps.Version}, nil)
		mcp.AddTool(server, &mcp.Tool{
			Name: "get_dashboard",
			Description: "Fetch the aggregated open pull requests, issues, and CI/forge " +
				"health this dashboard already tracks across GitHub and Forgejo -- " +
				"the same read-only data the web UI's own dashboard renders. Read-only: " +
				"this app never writes to either forge through this tool.",
		}, func(ctx context.Context, _ *mcp.CallToolRequest, input getDashboardInput) (*mcp.CallToolResult, dashboardResponse, error) {
			if !ok {
				return nil, dashboardResponse{}, errors.New("no authenticated user in context")
			}

			resp, err := resolveDashboardFor(ctx, deps, u, input.Owner)
			if err != nil {
				return nil, dashboardResponse{}, err
			}

			return nil, resp, nil
		})

		return server
	}

	return mcp.NewStreamableHTTPHandler(getServer, nil)
}
