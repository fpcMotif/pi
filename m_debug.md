# Microsoft Store Install Debug Summary

## Key root cause

The failures were caused by the Microsoft Store install path using the wrong or broken proxy route.

The machine had Clash running on `127.0.0.1:23936`, but Windows Store traffic was not consistently going through it:

- WinHTTP proxy was set to `127.0.0.1:23936`.
- The WinHTTP bypass list included `*.microsoft.com`.
- Microsoft Store endpoints such as `purchase.mp.microsoft.com`, `storeedgefd.dsx.mp.microsoft.com`, `displaycatalog.mp.microsoft.com`, and `store-images.s-microsoft.com` therefore bypassed the proxy or hit a malformed Store-service proxy path.
- Direct connection to Microsoft Store endpoints failed.

So the key issue was not Codex or Raycast themselves. It was the Windows Store acquisition service network/proxy state.

## Why it failed before

### 1. Store UI failed with `0x80072EFD`

The Store event log showed failed requests to Microsoft Store endpoints with `0x80072EFD`.

This means the Store could not connect to the server. Direct TCP checks to `purchase.mp.microsoft.com:443` also failed.

At that point, the Store was still effectively trying an unusable network path.

### 2. WinGet failed with `0x80070057`

After proxy access improved, `winget` could fetch the Codex Store manifest:

- Product ID: `9PLM9XGG6VKS`
- Package family: `OpenAI.Codex_2p2nqsd0c76g0`
- Market: `AU`

But install then failed inside the Store acquisition layer with:

```text
0x80070057 : The parameter is incorrect.
```

The log showed the failure after installer selection, inside `WindowsPackageManager.dll` / Store install service.

The likely cause was the Store service still receiving a proxy/bypass configuration it could not use reliably.

### 3. Raycast bootstrapper also failed

The downloaded Raycast installer was valid and Microsoft-signed, but it was only a Microsoft Store installer bootstrapper.

That means it still depended on the same Store install service. So it hit the same Store acquisition/proxy/session problem.

## What changed before success

The working setup made the Store path simple and consistent:

```text
WinHTTP proxy:
  proxy-server = 127.0.0.1:23936
  bypass-list  = localhost;127.0.0.1

Current-user proxy:
  ProxyEnable   = 1
  ProxyServer   = 127.0.0.1:23936
  ProxyOverride = localhost;127.0.0.1;<local>
```

Other refresh steps:

- Ran `wsreset.exe`.
- Closed/restarted the Store process so it reloaded proxy state.
- Retried Store-backed installs after the Store acquisition service had refreshed.

## Why it succeeded this time

With the simplified proxy settings, the Store install service could:

1. Fetch the Store manifest.
2. Get entitlement for the package.
3. Download the package through the working proxy path.
4. Register the AppX package for the user.

For Codex, the successful evidence was:

```text
winget install --source msstore --id 9PLM9XGG6VKS ... -> installed successfully
Store install log: EndInstall HResult = 0
AppX deployment log: Register operation completed for OpenAI.Codex_26.506.3741.0_x64__2p2nqsd0c76g0
winget list codex -> Codex 9PLM9XGG6VKS 26.506.3741.0 msstore
```

## Practical takeaway

For Microsoft Store apps on this machine, do not only retry the Store UI.

First make the Store service network route clean:

```powershell
netsh winhttp set proxy 127.0.0.1:23936 "localhost;127.0.0.1"
```

And keep the user proxy aligned:

```powershell
ProxyEnable   = 1
ProxyServer   = 127.0.0.1:23936
ProxyOverride = localhost;127.0.0.1;<local>
```

Then reset/restart Store and retry `winget install --source msstore ...`.
