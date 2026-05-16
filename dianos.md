# Microsoft Store Codex/Raycast diagnosis

Date: 2026-05-14

## Result

I failed to install Codex and Raycast.

The apps are available in Microsoft Store, but the Microsoft Store/WinGet acquisition path fails on this machine before the package download/install starts.

## Main failure reasons

1. Microsoft Store UI fails during free order/entitlement creation:
   - `OrderCreationFailed`
   - `0x80072EFD`
   - failing endpoint: `https://purchase.mp.microsoft.com/v7.0/users/me/orders`
   - exception: `WinStore.Network.TransportException`

2. `winget install --source msstore --id 9PLM9XGG6VKS` fails after package discovery/manifest selection:
   - HRESULT: `0x80070057`
   - Chinese message: `参数错误`
   - WinGet log shows metadata fetch succeeded, then `WindowsPackageManager.dll` failed after package agreements were accepted.

3. System proxy is local:
   - WinHTTP/user proxy: `127.0.0.1:23936`
   - Store/UWP + localhost proxy is a common failure mode.
   - I could not fully force WinGet to bypass proxy because `--no-proxy` requires admin-enabled WinGet proxy command-line options.

4. Direct offline download was blocked:
   - `winget download --source msstore ... --skip-license` failed.
   - WinGet says Microsoft Store package download requires Microsoft Entra ID authentication and admin/license role.

5. Manual registration was impossible because the packages were not staged:
   - `Add-AppxPackage -RegisterByFamilyName -MainPackage OpenAI.Codex_2p2nqsd0c76g0`
   - failed with `0x80073CF1`: package not found/staged.

## Approaches tried

Total approaches tried: 12.

1. Read the screenshot error.
   - Store dialog only said retry later.
   - Correlation/time in screenshot matched Store logs.

2. Checked Store packages and services.
   - `Microsoft.WindowsStore`, `Microsoft.StorePurchaseApp`, and `Microsoft.DesktopAppInstaller` installed and status OK.
   - `InstallService`, `BITS`, `DoSvc`, `wuauserv`, `ClipSVC` running.

3. Read Microsoft Store event logs.
   - Found `OrderCreationFailed`, `0x80072EFD`, `WinStore.Network.TransportException`.
   - This identified failure at Microsoft Store purchase/order creation, not app search.

4. Checked network and proxy settings.
   - Found proxy `127.0.0.1:23936`.
   - Some Microsoft endpoints worked, but Store purchase/error-message endpoints showed network failures/timeouts.

5. Tested Store endpoints directly with curl.
   - `purchase.mp.microsoft.com`, `displaycatalog.mp.microsoft.com`, and image endpoints were reachable directly.
   - `cem.services.microsoft.com` had DNS/TLS/proxy problems.

6. Confirmed apps exist in Microsoft Store via WinGet.
   - Codex: `9PLM9XGG6VKS`, publisher OpenAI.
   - Raycast: `9PFXXSHC64H3`, publisher Raycast Technologies Ltd.

7. Tried `winget install` for Codex with normal msstore source.
   - Failed with `0x80070057`.

8. Tried `winget install` with accepted agreements and verbose logs.
   - Still failed with `0x80070057`.
   - Logs showed package metadata/manifest fetch succeeded, then handoff failed in `WindowsPackageManager.dll`.

9. Tried `winget install --no-proxy`.
   - Failed before install because WinGet proxy command-line options are disabled by admin setting.

10. Tried UWP loopback exemptions for Store/PurchaseApp/DesktopAppInstaller.
   - Add command reported admin access denied.
   - Listing showed exemptions present afterward, but retry still failed.

11. Tried offline Microsoft Store package download.
   - `winget download --source msstore --id 9PLM9XGG6VKS --skip-license`
   - Failed because Store package downloads require Microsoft Entra ID authorization/admin role.

12. Queried Microsoft DisplayCatalog directly and tried manual package path.
   - Successfully retrieved metadata:
     - Codex PFN: `OpenAI.Codex_2p2nqsd0c76g0`
     - Codex package: `OpenAI.Codex_26.506.3741.0_x64__2p2nqsd0c76g0`
     - Raycast PFN: `Raycast.Raycast_qypenmj9wpt2a`
     - Raycast package: `Raycast.Raycast_0.58.0.0_x64__qypenmj9wpt2a`
   - No direct package URL was exposed; fulfillment is through Windows Update/Store.
   - `Add-AppxPackage -RegisterByFamilyName` failed because package was not staged.

## What I should have done better

I should have stopped earlier once both Store UI and WinGet proved the same acquisition path was broken. I spent too long trying alternate install paths after the blocker was already clear.

## Best next actions

1. Run from an elevated PowerShell:

```powershell
winget settings --enable ProxyCommandLineOptions
```

2. Then retry without proxy:

```powershell
winget install --source msstore --id 9PLM9XGG6VKS --exact --accept-package-agreements --accept-source-agreements --no-proxy
winget install --source msstore --id 9PFXXSHC64H3 --exact --accept-package-agreements --accept-source-agreements --no-proxy
```

3. If that still fails, temporarily disable the local proxy/VPN or enable TUN/system VPN mode, then run:

```powershell
wsreset.exe
```

4. Retry install from Microsoft Store or WinGet.

5. If Store still fails, the remaining fix likely requires Windows Store repair/reset or running the install under a Microsoft account/Store account state that can create free entitlements.
