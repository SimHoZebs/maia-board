package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
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
// bearer sessions. A nil service means open mode (old databases without
// users, and unit tests); NewServer always wires one.
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

// requireUser enforces authentication when auth is wired; in open mode
// (auth == nil) it returns nil without error.
func (s *Server) requireUser(ctx context.Context) (*store.User, error) {
	if !s.authEnabled() {
		return nil, nil
	}
	if user, ok := userFromCtx(ctx); ok {
		return user, nil
	}
	return nil, apiError(http.StatusUnauthorized, "unauthenticated", "login is required")
}

func sessionCookie(token string, expires time.Time) http.Cookie {
	return http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  expires,
	}
}

func clearedSessionCookie() http.Cookie {
	return http.Cookie{Name: SessionCookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode}
}

// authTokenInput reads the session token the same way the middleware does:
// session cookie first, Bearer fallback. The cookie struct tag repeats
// SessionCookieName literally (struct tags cannot reference constants).
type authTokenInput struct {
	SessionCookie string `cookie:"maia_board_session"`
	Authorization string `header:"Authorization"`
}

func tokenFromInput(in authTokenInput) string {
	if in.SessionCookie != "" {
		return in.SessionCookie
	}
	if header := in.Authorization; strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return strings.TrimSpace(header[7:])
	}
	return ""
}

// tokenFromCtx returns the session token the authContext middleware already
// resolved for this request (empty when absent, invalid, or in open mode).
func tokenFromCtx(ctx context.Context) string {
	if token, ok := ctx.Value(ctxSessionKey).(string); ok {
		return token
	}
	return ""
}

// Session endpoints are Huma ops (registered in api.go) so the generated
// spec covers them. Behavior mirrors the former plain-Chi handlers
// byte-for-byte, including log lines, envelope codes, and cookie attributes.
type loginInput struct {
	Body *struct {
		DisplayName string `json:"display_name"`
	}
}

type loginOutput struct {
	SetCookie http.Cookie `header:"Set-Cookie"`
	Body      store.User
}

func (s *Server) serveLocalLogin(ctx context.Context, input *loginInput) (*loginOutput, error) {
	if s.store == nil || !s.authEnabled() {
		return nil, apiError(http.StatusServiceUnavailable, "auth_disabled", "accounts are not enabled on this server")
	}
	name := ""
	if input.Body != nil {
		name = input.Body.DisplayName
	}
	if err := store.ValidateDisplayName(name); err != nil {
		return nil, apiError(http.StatusBadRequest, "invalid_display_name", "display_name must be 1-40 printable characters")
	}
	user, err := s.auth.store.CreateLocalUser(name)
	if err != nil {
		if errors.Is(err, store.ErrInvalidDisplayName) {
			return nil, apiError(http.StatusBadRequest, "invalid_display_name", "display_name must be 1-40 printable characters")
		}
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "account store is unavailable")
	}
	session, err := s.auth.store.CreateSession(user.ID, s.auth.ttl)
	if err != nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "account store is unavailable")
	}
	expires, _ := time.Parse(time.RFC3339Nano, session.ExpiresAt)
	if expires.IsZero() {
		expires = time.Now().Add(s.auth.ttl)
	}
	log.Printf("auth status=%d action=local-login user=%s", http.StatusOK, user.ID)
	out := &loginOutput{SetCookie: sessionCookie(session.ID, expires)}
	out.Body = user
	return out, nil
}

type logoutOutput struct {
	SetCookie http.Cookie `header:"Set-Cookie"`
}

func (s *Server) serveLogout(ctx context.Context, _ *struct{}) (*logoutOutput, error) {
	if token := tokenFromCtx(ctx); token != "" && s.authEnabled() {
		_ = s.auth.store.DeleteSession(token)
	}
	log.Printf("auth status=%d action=logout", http.StatusNoContent)
	return &logoutOutput{SetCookie: clearedSessionCookie()}, nil
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

// serveMe re-reads the session row instead of trusting the middleware
// identity, so a revoked token fails closed even mid-request.
type meInput struct {
	authTokenInput
}

type meOutput struct {
	Body store.User
}

func (s *Server) serveMe(ctx context.Context, input *meInput) (*meOutput, error) {
	if !s.authEnabled() {
		return nil, apiError(http.StatusServiceUnavailable, "auth_disabled", "accounts are not enabled on this server")
	}
	token := tokenFromInput(input.authTokenInput)
	if token == "" {
		return nil, apiError(http.StatusUnauthorized, "unauthenticated", "login is required")
	}
	user, err := s.auth.store.SessionUser(token)
	if err != nil {
		return nil, apiError(http.StatusUnauthorized, "unauthenticated", "login is required")
	}
	out := &meOutput{}
	out.Body = user
	return out, nil
}

func (s *Server) validRedirectURI(candidate string) bool {
	if candidate == "/auth/lichess/callback" {
		return true
	}
	return candidate != "" && candidate == s.auth.lichessRedirect
}

type lichessStartInput struct {
	// redirect_uri rides the query string on both the GET and POST legs;
	// POST bodies are ignored, as before.
	RedirectURI string `query:"redirect_uri"`
}

type lichessStartOutput struct {
	Body lichessStartBody
}

type lichessStartBody struct {
	AuthorizationURL string `json:"authorization_url"`
	State            string `json:"state"`
}

func (s *Server) serveLichessStart(ctx context.Context, input *lichessStartInput) (*lichessStartOutput, error) {
	if !s.authEnabled() {
		return nil, apiError(http.StatusServiceUnavailable, "auth_disabled", "accounts are not enabled on this server")
	}
	if s.auth.lichessID == "" {
		return nil, apiError(http.StatusNotImplemented, "oauth_unconfigured", "Lichess login is not configured (LICHESS_CLIENT_ID)")
	}
	redirectURI := input.RedirectURI
	if redirectURI == "" {
		redirectURI = s.auth.lichessRedirect
	}
	if redirectURI == "" {
		return nil, apiError(http.StatusBadRequest, "invalid_request", "redirect_uri is required")
	}
	if !s.validRedirectURI(redirectURI) {
		return nil, apiError(http.StatusBadRequest, "invalid_request", "redirect_uri is not allowed")
	}
	state, err := newStateToken()
	if err != nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "login is unavailable")
	}
	verifier, err := newStateToken()
	if err != nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "login is unavailable")
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
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "login is unavailable")
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
	out := &lichessStartOutput{}
	out.Body.AuthorizationURL = authURL.String()
	out.Body.State = state
	return out, nil
}

type lichessAccount struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

type lichessCallbackInput struct {
	Code  string `query:"code"`
	State string `query:"state"`
	// Also accept a JSON body for same-origin POST clients, as before.
	Body *lichessCallbackBody
}

type lichessCallbackBody struct {
	Code  string `json:"code"`
	State string `json:"state"`
}

type lichessCallbackGetOutput struct {
	Location  string      `header:"Location"`
	SetCookie http.Cookie `header:"Set-Cookie"`
}

type lichessCallbackPostOutput struct {
	SetCookie http.Cookie `header:"Set-Cookie"`
	Body      store.User
}

func (s *Server) lichessCallbackLogin(ctx context.Context, code, state string) (*store.User, *http.Cookie, error) {
	if code == "" || state == "" {
		return nil, nil, apiError(http.StatusBadRequest, "invalid_request", "code and state are required")
	}
	pending, err := s.auth.store.ConsumeOAuthState(state)
	if err != nil {
		return nil, nil, apiError(http.StatusBadRequest, "invalid_request", "unknown or expired login attempt")
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
	tokenReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://lichess.org/api/token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, nil, apiError(http.StatusBadGateway, "engine_unavailable", "login is unavailable")
	}
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenResp, err := s.auth.client.Do(tokenReq)
	if err != nil {
		return nil, nil, apiError(http.StatusBadGateway, "oauth_unavailable", "Lichess did not answer")
	}
	defer tokenResp.Body.Close()
	var tokenBody struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(tokenResp.Body, 64*1024+1)).Decode(&tokenBody)
	if tokenResp.StatusCode != http.StatusOK || tokenBody.AccessToken == "" {
		return nil, nil, apiError(http.StatusBadGateway, "oauth_failed", "Lichess refused the login")
	}
	accountReq, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://lichess.org/api/account", nil)
	if err != nil {
		return nil, nil, apiError(http.StatusBadGateway, "engine_unavailable", "login is unavailable")
	}
	accountReq.Header.Set("Authorization", "Bearer "+tokenBody.AccessToken)
	accountResp, err := s.auth.client.Do(accountReq)
	if err != nil {
		return nil, nil, apiError(http.StatusBadGateway, "oauth_unavailable", "Lichess did not answer")
	}
	defer accountResp.Body.Close()
	var account lichessAccount
	if err := json.NewDecoder(io.LimitReader(accountResp.Body, 64*1024+1)).Decode(&account); err != nil || account.ID == "" || account.Username == "" {
		return nil, nil, apiError(http.StatusBadGateway, "oauth_failed", "Lichess refused the login")
	}
	user, err := s.auth.store.UpsertLichessUser(account.ID, account.Username)
	if err != nil {
		return nil, nil, apiError(http.StatusBadGateway, "engine_unavailable", "account store is unavailable")
	}
	session, err := s.auth.store.CreateSession(user.ID, s.auth.ttl)
	if err != nil {
		return nil, nil, apiError(http.StatusBadGateway, "engine_unavailable", "account store is unavailable")
	}
	expires, _ := time.Parse(time.RFC3339Nano, session.ExpiresAt)
	if expires.IsZero() {
		expires = time.Now().Add(s.auth.ttl)
	}
	cookie := sessionCookie(session.ID, expires)
	log.Printf("auth status=%d action=lichess-callback user=%s lichess=%s", http.StatusOK, user.ID, account.Username)
	return &user, &cookie, nil
}

// serveLichessCallbackGet is the browser navigation leg: it lands back in
// the app with a 302 and the session cookie.
func (s *Server) serveLichessCallbackGet(ctx context.Context, input *lichessCallbackInput) (*lichessCallbackGetOutput, error) {
	if !s.authEnabled() {
		return nil, apiError(http.StatusServiceUnavailable, "auth_disabled", "accounts are not enabled on this server")
	}
	code, state := input.Code, input.State
	if (code == "" || state == "") && input.Body != nil {
		if code == "" {
			code = input.Body.Code
		}
		if state == "" {
			state = input.Body.State
		}
	}
	_, cookie, err := s.lichessCallbackLogin(ctx, code, state)
	if err != nil {
		return nil, err
	}
	return &lichessCallbackGetOutput{Location: "/settings?login=ok", SetCookie: *cookie}, nil
}

// serveLichessCallbackPost is the programmatic leg: it answers the user JSON
// instead of redirecting.
func (s *Server) serveLichessCallbackPost(ctx context.Context, input *lichessCallbackInput) (*lichessCallbackPostOutput, error) {
	if !s.authEnabled() {
		return nil, apiError(http.StatusServiceUnavailable, "auth_disabled", "accounts are not enabled on this server")
	}
	code, state := input.Code, input.State
	if (code == "" || state == "") && input.Body != nil {
		if code == "" {
			code = input.Body.Code
		}
		if state == "" {
			state = input.Body.State
		}
	}
	user, cookie, err := s.lichessCallbackLogin(ctx, code, state)
	if err != nil {
		return nil, err
	}
	out := &lichessCallbackPostOutput{SetCookie: *cookie}
	out.Body = *user
	return out, nil
}
