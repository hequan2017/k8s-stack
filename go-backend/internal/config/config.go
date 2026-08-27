// Package config loads runtime configuration from environment variables.
// No credentials are ever hardcoded; everything is injected via env or in-cluster ServiceAccount.
package config

import "os"

type Config struct {
	// Port the HTTP server listens on.
	Port string
	// AdminPassword enables UI/API authentication when non-empty.
	// When empty, authentication is disabled (trusted intranet mode).
	AdminPassword string
	// SessionTTLHours is how long an issued login token stays valid.
	SessionTTLHours int
	// SandboxPrefix namespaces created for platform sandboxes must start with this prefix.
	SandboxPrefix string
	// DiscoveryNamespaces lists extra namespaces scanned for foreign sandbox pods (e.g. e2b).
	DiscoveryNamespaces []string
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func Load() *Config {
	return &Config{
		Port:            env("PORT", "8080"),
		AdminPassword:   os.Getenv("ADMIN_PASSWORD"), // empty => auth disabled
		SessionTTLHours: 24,
		SandboxPrefix:   "sbx-",
		DiscoveryNamespaces: []string{
			env("DISCOVERY_NAMESPACE", "opensandbox"),
		},
	}
}
