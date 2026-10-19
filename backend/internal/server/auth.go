package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"maia-board/backend/internal/store"
)

// SessionCookieName carries the opaque session token. HttpOnly + SameSite=Lax
// keeps the same-origin SPA safe without JavaScript ever reading the token.
const SessionCookieName = "maia_board_session"

// DefaultSessionTTL is 30 days of remembered login.
const DefaultSessionTTL = 30 * 24 * time.Hour

type ctxKey string

const (
	ctxUserKey    ctxKey = "maia_user"
	ctxSessionKey ctxKey = "maia_session"
)

// AuthService owns the user primitive: local users, Lichess linkage, and
// bearer sessions. A nil *AuthService on Server means legacy open mode
// (pre-user databases and unit tests); NewServer always wires one.
type AuthService struct {
	store           *store.GameStore
	ttl             time.Duration
	client          *http.Client
	lichessID       string
	lichessSecret   string
	lichessRedirect string
}

// NewAuthService wires sessions over gameStore. Lichess OAuth reads
// LICHESS_CLIENT_ID / LICHESS_CLIENT_SECRET / LICHESS_REDIRECT_URI so the
// self-hosted deployment configures exactly one Lichess app registration.
func NewAuthService(gameStore *store.GameStore, ttl time.Duration) *AuthService {
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	return &AuthService{
		store:           gameStore,
		ttl:             ttl,
		client:          &http.Client{Timeout: 10 * time.Second},
		lichessID:       os.Getenv("LICHESS_CLIENT_ID"),
		lichessSecret:   os.Getenv("LICHESS_CLIENT_SECRET"),
		lichessRedirect: os.Getenv("LICHESS_REDIRECT_URI"),
	}
}

func (s *Server) authEnabled() bool {
	return s != nil && s.auth != nil && s.auth.store != nil
}

// authContext resolves the session cookie (or Bearer token) into the request
// context. It never blocks: handlers enforce 401 when auth is enabled.
func (s *Server) authContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s == nil || s.auth == nil || s.auth.store == nil {
			next.ServeHTTP(w, r)
			return
		}
		token := sessionTokenFromRequest(r)
		if token == "" {
			next.ServeHTTP(w, r)
			return
		}
		user, err := s.auth.store.SessionUser(token)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		ctx := context.WithValue(r.Context(), ctxUserKey, &user)
		ctx = context.WithValue(ctx, ctxSessionKey, token)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func sessionTokenFromRequest(r *http.Request) string {
	if cookie, err := r.Cookie(SessionCookieName); err == nil && cookie.Value != "" {
		return cookie.Value
	}
	if header := r.Header.Get("Authorization"); strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return ""
}

// currentUser returns the session user, if any.
func userFromCtx(ctx context.Context) (*store.User, bool) {
	user, ok := ctx.Value(ctxUserKey).(*store.User)
	return user, ok && user != nil
}

// requireUser enforces authentication when the server runs with auth wired.
// Legacy open mode (auth == nil, unit tests) returns ok=false without error.
func (s *Server) requireUser(ctx context.Context) (*store.User, error) {
	if !s.authEnabled() {
		return nil, nil
	}
	if user, ok := userFromCtx(ctx); ok {
		return user, nil
	}
	return nil, apiError(http.StatusUnauthorized, "unauthenticated", "login is required")
}

func setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  expires,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: SessionCookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func newStateToken() (string, error) {
	var bytes [24]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// Auth request/response documents use plain Chi handlers (Huma cannot set
// cookies), so shapes are unregistered JSON: User rows and
// {authorization_url, state} maps.

// The Huma JSON path cannot set cookies, so session issuance uses plain Chi
// handlers mounted alongside the Huma ops. Shapes stay identical.
func (s *Server) serveLocalLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if s.store == nil || !s.authEnabled() {
		writeHumaError(w, http.StatusServiceUnavailable, "auth_disabled", "accounts are not enabled on this server")
		return
	}
	var body struct {
		DisplayName string `json:"display_name"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body)
	if err := store.ValidateDisplayName(body.DisplayName); err != nil {
		writeHumaError(w, http.StatusBadRequest, "invalid_display_name", "display_name must be 1-40 printable characters")
		return
	}
	user, err := s.auth.store.CreateLocalUser(body.DisplayName)
	if err != nil {
		if errors.Is(err, store.ErrInvalidDisplayName) {
			writeHumaError(w, http.StatusBadRequest, "invalid_display_name", "display_name must be 1-40 printable characters")
			return
		}
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "account store is unavailable")
		return
	}
	session, err := s.auth.store.CreateSession(user.ID, s.auth.ttl)
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "account store is unavailable")
		return
	}
	expires, _ := time.Parse(time.RFC3339Nano, session.ExpiresAt)
	if expires.IsZero() {
		expires = time.Now().Add(s.auth.ttl)
	}
	setSessionCookie(w, session.ID, expires)
	log.Printf("auth status=%d action=local-login user=%s", http.StatusOK, user.ID)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(user)
}

func (s *Server) serveLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if token := sessionTokenFromRequest(r); token != "" && s.authEnabled() {
		_ = s.auth.store.DeleteSession(token)
	}
	clearSessionCookie(w)
	log.Printf("auth status=%d action=logout", http.StatusNoContent)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) serveMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if !s.authEnabled() {
		writeHumaError(w, http.StatusServiceUnavailable, "auth_disabled", "accounts are not enabled on this server")
		return
	}
	token := sessionTokenFromRequest(r)
	if token == "" {
		writeHumaError(w, http.StatusUnauthorized, "unauthenticated", "login is required")
		return
	}
	user, err := s.auth.store.SessionUser(token)
	if err != nil {
		writeHumaError(w, http.StatusUnauthorized, "unauthenticated", "login is required")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(user)
}

func (s *Server) serveLichessStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if !s.authEnabled() {
		writeHumaError(w, http.StatusServiceUnavailable, "auth_disabled", "accounts are not enabled on this server")
		return
	}
	if s.auth.lichessID == "" {
		writeHumaError(w, http.StatusNotImplemented, "oauth_unconfigured", "Lichess login is not configured (LICHESS_CLIENT_ID)")
		return
	}
	redirectURI := r.URL.Query().Get("redirect_uri")
	if redirectURI == "" {
		redirectURI = s.auth.lichessRedirect
	}
	if redirectURI == "" {
		writeHumaError(w, http.StatusBadRequest, "invalid_request", "redirect_uri is required")
		return
	}
	state, err := newStateToken()
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "login is unavailable")
		return
	}
	verifier, err := newStateToken()
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "login is unavailable")
		return
	}
	now := time.Now().UTC()
	pending := store.OAuthState{
		State:       state,
		Verifier:    verifier + verifier,
		RedirectURI: redirectURI,
		CreatedAt:   now.Format(time.RFC3339Nano),
		ExpiresAt:   now.Add(10 * time.Minute).Format(time.RFC3339Nano),
	}
	if err := s.auth.store.StoreOAuthState(pending); err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "login is unavailable")
		return
	}
	authURL := url.URL{Scheme: "https", Host: "lichess.org", Path: "/oauth"}
	query := authURL.Query()
	query.Set("response_type", "code")
	query.Set("client_id", s.auth.lichessID)
	query.Set("redirect_uri", redirectURI)
	query.Set("scope", "preference:read")
	query.Set("code_challenge_method", "S256")
	query.Set("code_challenge", pkceChallenge(pending.Verifier))
	query.Set("state", state)
	authURL.RawQuery = query.Encode()
	log.Printf("auth status=%d action=lichess-start", http.StatusOK)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"authorization_url": authURL.String(), "state": state})
}

type lichessAccount struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

func (s *Server) serveLichessCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if !s.authEnabled() {
		writeHumaError(w, http.StatusServiceUnavailable, "auth_disabled", "accounts are not enabled on this server")
		return
	}
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		// Also accept a JSON body for same-origin POST clients.
		var body struct {
			Code  string `json:"code"`
			State string `json:"state"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body)
		if code == "" {
			code = body.Code
		}
		if state == "" {
			state = body.State
		}
	}
	if code == "" || state == "" {
		writeHumaError(w, http.StatusBadRequest, "invalid_request", "code and state are required")
		return
	}
	pending, err := s.auth.store.ConsumeOAuthState(state)
	if err != nil {
		writeHumaError(w, http.StatusBadRequest, "invalid_request", "unknown or expired login attempt")
		return
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("code_verifier", pending.Verifier)
	form.Set("client_id", s.auth.lichessID)
	form.Set("redirect_uri", pending.RedirectURI)
	if s.auth.lichessSecret != "" {
		form.Set("client_secret", s.auth.lichessSecret)
	}
	tokenReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://lichess.org/api/token", strings.NewReader(form.Encode()))
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "login is unavailable")
		return
	}
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenResp, err := s.auth.client.Do(tokenReq)
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "oauth_unavailable", "Lichess did not answer")
		return
	}
	defer tokenResp.Body.Close()
	var tokenBody struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, tokenResp.Body, 64*1024)).Decode(&tokenBody)
	if tokenResp.StatusCode != http.StatusOK || tokenBody.AccessToken == "" {
		writeHumaError(w, http.StatusBadGateway, "oauth_failed", "Lichess refused the login")
		return
	}
	accountReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://lichess.org/api/account", nil)
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "login is unavailable")
		return
	}
	accountReq.Header.Set("Authorization", "Bearer "+tokenBody.AccessToken)
	accountResp, err := s.auth.client.Do(accountReq)
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "oauth_unavailable", "Lichess did not answer")
		return
	}
	defer accountResp.Body.Close()
	var account lichessAccount
	if err := json.NewDecoder(http.MaxBytesReader(w, accountResp.Body, 64*1024)).Decode(&account); err != nil || account.ID == "" || account.Username == "" {
		writeHumaError(w, http.StatusBadGateway, "oauth_failed", "Lichess refused the login")
		return
	}
	user, err := s.auth.store.UpsertLichessUser(account.ID, account.Username)
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "account store is unavailable")
		return
	}
	session, err := s.auth.store.CreateSession(user.ID, s.auth.ttl)
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "account store is unavailable")
		return
	}
	expires, _ := time.Parse(time.RFC3339Nano, session.ExpiresAt)
	if expires.IsZero() {
		expires = time.Now().Add(s.auth.ttl)
	}
	setSessionCookie(w, session.ID, expires)
	log.Printf("auth status=%d action=lichess-callback user=%s lichess=%s", http.StatusOK, user.ID, account.Username)
	// Browser navigation (the OAuth redirect leg) lands back in the app;
	// programmatic POST clients get the user JSON instead.
	if r.Method == http.MethodGet {
		http.Redirect(w, r, "/settings?login=ok", http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(user)
}
