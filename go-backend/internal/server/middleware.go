package server

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// tokenStore keeps issued login tokens in memory; nothing sensitive is persisted to disk.
type tokenStore struct {
	mu      sync.Mutex
	tokens  map[string]time.Time
	ttl     time.Duration
	enabled bool
}

var auth = &tokenStore{tokens: map[string]time.Time{}, ttl: 24 * time.Hour}

func InitAuth(password string, ttlHours int) {
	adminPwd = password
	auth.enabled = password != ""
	if password != "" && ttlHours > 0 {
		auth.ttl = time.Duration(ttlHours) * time.Hour
	}
}

func AuthEnabled() bool { return auth.enabled }

func (s *tokenStore) issue() string {
	b := make([]byte, 24)
	rand.Read(b)
	tok := hex.EncodeToString(b)
	s.mu.Lock()
	s.tokens[tok] = time.Now().Add(s.ttl)
	s.mu.Unlock()
	return tok
}

func (s *tokenStore) valid(tok string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.tokens[tok]
	if !ok {
		return false
	}
	if time.Now().After(exp) {
		delete(s.tokens, tok)
		return false
	}
	return true
}

func bearer(c *gin.Context) string {
	h := c.GetHeader("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return c.Query("token")
}

// requireAuth is skipped entirely when ADMIN_PASSWORD is unset.
func requireAuth(c *gin.Context) {
	if !auth.enabled {
		c.Next()
		return
	}
	if bearer(c) != "" && auth.valid(bearer(c)) {
		c.Next()
		return
	}
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
}
