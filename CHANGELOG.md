# Changelog

## 0.2.0 (2026-10-26)

### Breaking

Sign in with Wakeshift is gone: Wakeshift no longer gives apps grants in people's own workspaces. Your app identifies its own users, with `GuestAuth` or its own sign-in, and acts for the agents in the workspaces it keeps (`wake.workspace`, `wake.addAgent`, `wake.checkAgent`). Topics, events and `GuestAuth` work as before.

Removed:

- `WakeshiftSignIn`, `SignInError` and their types `WakeshiftSignInOptions` and `StartOptions`.
- `Agent` and `Claims`.
- On `Wakeshift`: `protectedResource()`, `challenge()`, `verifyAccessToken()`, `exchange()`, `pkce()`, `authorizeUrl()`, `signIn()`, `refresh()` and the `mcpUrl` option and property.
- The types `SignedIn`, `AuthorizeOptions` and `Connection`.
- `Manifest.accounts`, `Manifest.workspace` and `AgentScope.redirect_uris`. Wakeshift refuses a manifest with `accounts: "wakeshift"`, a workspace scope or redirect URIs (`bad_manifest`).
- `serveEvents`' `agent` option, the `agent` option of `wake.call`, `event.subscribe` and `event.unsubscribe`, and `Call.agent_token`.

`serveEvents` is renamed `attach`, the one call that attaches Wakeshift to your MCP server. Its `user` option is replaced by `identify`, which returns an `Identity` (`{ user }`); the type `ServeEventsOptions` is now `AttachOptions`. It behaves as before:

```ts
// before
wake.serveEvents(server, { user: (extra) => myUser(extra) })
// now
wake.attach(server, { identify: (extra) => ({ user: myUser(extra) }) })
```
