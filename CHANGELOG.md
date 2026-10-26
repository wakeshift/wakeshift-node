# Changelog

## 0.3.0 (2026-10-26)

### Breaking

Guest sign-in is gone. Your app identifies its own users with its own sign-in, and passes `identify` to `attach` to say who is behind each request. Apps on 0.2 that use `GuestAuth` must replace it with their own sign-in before upgrading.

Removed:

- `GuestAuth`, `guestOf` and their types `Guest`, `GuestAuthOptions` and `GuestAuthInfo`.
- `Wakeshift.secretSeed()`, which only `GuestAuth` used.
- `attach`'s default `identify`, which read the guest `GuestAuth` signed in. Without `identify`, requests have no user, so personal events and `list_subscriptions` refuse.

```ts
// before
wake.attach(server)
// now
wake.attach(server, { identify: (extra) => ({ user: myUser(extra) }) })
```

`wake.workspace`, `wake.addAgent`, `wake.checkAgent` and `harnessAgent` stay: they serve the users your own sign-in identifies.

### Added

- `Call.tool`, set with `wake.call(extra, { tool })` or `wake.callOf({ tool })`: the name of the tool being called. The connector beacon Wakeshift adds to a result names that tool, and Wakeshift's hooks act on it only from that tool's result, so pass it for wake-ups to connect with updated hooks. The tools `attach` adds, and `defineEvent`'s `subscribe` and `unsubscribe` (new `tool` option), pass theirs.

### Changed

- An app's user has at most 20 live MCP Events webhook subscriptions. Wakeshift refuses one more with `403 subscription_limit`, which `attach` answers with MCP Events' `ResourceExhausted` (`InvalidParams` for ChatGPT), with data `{ kind: "subscriptions" }`.

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
