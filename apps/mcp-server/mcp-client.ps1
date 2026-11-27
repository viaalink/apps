<#
.SYNOPSIS
    MCP Client - Communiceer met de MCP Server vanuit PowerShell.

.DESCRIPTION
    Dit script biedt een command-line interface voor de MCP Server.
    Je kunt packages beheren, service status opvragen, en Redmine tickets bekijken.

    De MCP (Model Context Protocol) server draait op de eigen infrastructuur en
    biedt dezelfde functionaliteit als de 'just' commands, maar dan via een
    gestandaardiseerd protocol dat ook door AI agents gebruikt kan worden.

.PARAMETER Command
    Het uit te voeren commando. Beschikbare commando's:

    AUTHENTICATIE:
      login         - Login via Authentik SSO (opent browser)
      logout        - Verwijder opgeslagen tokens
      whoami        - Toon huidige login status

    UPDATES:
      update        - Download en installeer nieuwste versie
      version       - Toon huidige versie

    INFORMATIE:
      help          - Toon deze hulp
      tools         - Lijst alle beschikbare MCP tools
      health        - Controleer of de MCP server bereikbaar is

    PACKAGES:
      packages      - Lijst alle packages met status
      package       - Toon details van een specifiek package (gebruik -Name)
      search        - Zoek packages (gebruik -Query)

    SERVICES:
      status        - Toon status van een service (gebruik -Name)
      logs          - Toon logs van een service (gebruik -Name, optioneel -Lines)
      ecosystem     - Toon overzicht van alle services

    REDMINE:
      epics         - Lijst alle epics
      issues        - Zoek issues (optioneel -Query, -Tracker, -Status)
      issue         - Toon issue details (gebruik -Id)

.PARAMETER Name
    Naam van package of service (voor: package, status, logs, search)

.PARAMETER Id
    Issue ID (voor: issue)

.PARAMETER Query
    Zoekterm (voor: search, issues)

.PARAMETER Tracker
    Tracker type: bug, feature, support, epic (voor: issues)

.PARAMETER Status
    Status filter: open, closed, all (voor: epics, issues)

.PARAMETER Lines
    Aantal log regels (voor: logs, default: 50)

.PARAMETER Url
    MCP Server URL (default: from $env:MCP_SERVER_URL or http://localhost:3100)

.EXAMPLE
    .\mcp-client.ps1 health
    Controleert of de MCP server bereikbaar is.

.EXAMPLE
    .\mcp-client.ps1 tools
    Toont alle beschikbare MCP tools.

.EXAMPLE
    .\mcp-client.ps1 packages
    Lijst alle packages met hun status (running/stopped/available).

.EXAMPLE
    .\mcp-client.ps1 package -Name n8n
    Toont gedetailleerde informatie over het n8n package.

.EXAMPLE
    .\mcp-client.ps1 search -Query monitoring
    Zoekt packages die 'monitoring' bevatten.

.EXAMPLE
    .\mcp-client.ps1 status -Name mcp-server
    Toont de status van de mcp-server service.

.EXAMPLE
    .\mcp-client.ps1 logs -Name n8n -Lines 100
    Toont de laatste 100 log regels van n8n.

.EXAMPLE
    .\mcp-client.ps1 ecosystem
    Toont een overzicht: hoeveel services running/stopped/available.

.EXAMPLE
    .\mcp-client.ps1 epics
    Lijst alle open epics uit Redmine.

.EXAMPLE
    .\mcp-client.ps1 epics -Status all
    Lijst alle epics (ook gesloten).

.EXAMPLE
    .\mcp-client.ps1 issues -Tracker bug -Status open
    Zoekt alle open bugs.

.EXAMPLE
    .\mcp-client.ps1 issues -Query "MCP"
    Zoekt issues met 'MCP' in de titel.

.EXAMPLE
    .\mcp-client.ps1 issue -Id 744
    Toont details van issue #744.

.EXAMPLE
    .\mcp-client.ps1 login
    Start OAuth login via Authentik (opent browser).

.EXAMPLE
    .\mcp-client.ps1 whoami
    Toont huidige login status en token info.

.EXAMPLE
    .\mcp-client.ps1 logout
    Verwijdert opgeslagen tokens.

.NOTES
    Auteur: het team
    Versie: 1.0.0

    De MCP server moet bereikbaar zijn via de tunnel.
    Bij problemen: controleer of de tunnel actief is.

.LINK
    $env:MCP_SERVER_URL/health (or http://localhost:3100/health)
#>

<#
═══════════════════════════════════════════════════════════════════════════════
                              SNELLE REFERENTIE
═══════════════════════════════════════════════════════════════════════════════

# AUTHENTICATIE (NIEUW - OAuth2/SSO)
.\mcp-client.ps1 login                     # Login via Authentik (opent browser)
.\mcp-client.ps1 whoami                    # Toon huidige login status
.\mcp-client.ps1 logout                    # Verwijder opgeslagen tokens

# HULP
.\mcp-client.ps1 help                      # Toon hulp in terminal
.\mcp-client.ps1 -?                        # PowerShell native help
Get-Help .\mcp-client.ps1 -Full            # Volledige documentatie

# SERVER STATUS
.\mcp-client.ps1 health                    # Is de MCP server bereikbaar?
.\mcp-client.ps1 tools                     # Welke tools zijn beschikbaar?

# PACKAGES
.\mcp-client.ps1 packages                  # Alle packages (running/stopped/available)
.\mcp-client.ps1 package -Name n8n         # Details van specifiek package
.\mcp-client.ps1 search -Query monitoring  # Zoek packages op keyword

# SERVICES
.\mcp-client.ps1 status -Name mcp-server   # Status van een service
.\mcp-client.ps1 logs -Name n8n            # Laatste 50 log regels
.\mcp-client.ps1 logs -Name n8n -Lines 100 # Laatste 100 log regels
.\mcp-client.ps1 ecosystem                 # Overzicht: running/stopped/available

# REDMINE - EPICS
.\mcp-client.ps1 epics                     # Alle open epics
.\mcp-client.ps1 epics -Status closed      # Alle gesloten epics
.\mcp-client.ps1 epics -Status all         # Alle epics

# REDMINE - ISSUES
.\mcp-client.ps1 issues                    # Alle open issues
.\mcp-client.ps1 issues -Query "MCP"       # Zoek issues op keyword
.\mcp-client.ps1 issues -Tracker bug       # Alleen bugs
.\mcp-client.ps1 issues -Tracker feature   # Alleen features
.\mcp-client.ps1 issues -Status all        # Ook gesloten issues
.\mcp-client.ps1 issue -Id 744             # Details van issue #744

# CUSTOM SERVER URL
.\mcp-client.ps1 health -Url http://localhost:9125

═══════════════════════════════════════════════════════════════════════════════
#>

[CmdletBinding()]
param(
    [Parameter(Position=0)]
    [ValidateSet("help", "tools", "health", "packages", "package", "search",
                 "status", "logs", "ecosystem", "epics", "issues", "issue",
                 "login", "logout", "whoami", "api-key", "update", "version")]
    [string]$Command = "help",

    [Parameter()]
    [string]$Name,

    [Parameter()]
    [int]$Id,

    [Parameter()]
    [string]$Query,

    [Parameter()]
    [ValidateSet("bug", "feature", "support", "epic")]
    [string]$Tracker,

    [Parameter()]
    [ValidateSet("open", "closed", "all")]
    [string]$Status = "open",

    [Parameter()]
    [int]$Lines = 50,

    [Parameter()]
    [string]$Url = $(if ($env:MCP_SERVER_URL) { $env:MCP_SERVER_URL } else { "http://localhost:3100" })
)

# ============================================
# CONFIGURATIE
# ============================================

$script:Version = "1.5.3"

# Load System.Web for URL parsing
Add-Type -AssemblyName System.Web

$script:TokenFile = Join-Path $env:USERPROFILE ".mcp-client-token.json"
$script:AccessToken = $null

$script:Headers = @{
    "Content-Type" = "application/json"
    "Accept" = "text/event-stream, application/json"
}

$script:Initialized = $false

# ============================================
# OAUTH FUNCTIES
# ============================================

function Get-OAuthConfig {
    try {
        $config = Invoke-RestMethod -Uri "$Url/oauth/config?format=json" -Method GET -ErrorAction Stop
        return $config
    }
    catch {
        return $null
    }
}

function Load-Token {
    if (Test-Path $script:TokenFile) {
        try {
            $tokenData = Get-Content $script:TokenFile -Raw | ConvertFrom-Json
            # Check expiration
            $expires = [DateTime]::Parse($tokenData.expires_at)
            if ($expires -gt (Get-Date)) {
                $script:AccessToken = $tokenData.access_token
                $script:Headers["Authorization"] = "Bearer $($script:AccessToken)"
                return $true
            }
            else {
                Write-ColorHost "Token verlopen, login opnieuw met: .\mcp-client.ps1 login" "Yellow"
            }
        }
        catch {
            # Invalid token file
        }
    }
    return $false
}

function Save-Token {
    param(
        [string]$AccessToken,
        [int]$ExpiresIn,
        [string]$RefreshToken
    )

    $expiresAt = (Get-Date).AddSeconds($ExpiresIn)
    $tokenData = @{
        access_token = $AccessToken
        refresh_token = $RefreshToken
        expires_at = $expiresAt.ToString("o")
    }
    $tokenData | ConvertTo-Json | Set-Content $script:TokenFile

    $script:AccessToken = $AccessToken
    $script:Headers["Authorization"] = "Bearer $AccessToken"
}

function Remove-Token {
    if (Test-Path $script:TokenFile) {
        Remove-Item $script:TokenFile -Force
    }
    $script:AccessToken = $null
    $script:Headers.Remove("Authorization")
}

function Start-OAuthLogin {
    Write-ColorHost "`n[OAuth Login]" "Cyan"

    # Check if permanent API key already exists
    if (Test-Path $script:ApiKeyFile) {
        Write-ColorHost "  Je hebt al een permanente API key!" "Green"
        Write-Host "  Bestand: $script:ApiKeyFile"
        Write-Host ""
        return
    }

    # Check if we already have a valid temp token
    if ($script:AccessToken) {
        Write-ColorHost "  Je bent al ingelogd!" "Green"
        Write-Host ""
        return
    }

    # Get OAuth config from server
    $config = Get-OAuthConfig
    if (-not $config -or -not $config.enabled) {
        Write-ColorHost "  OAuth is niet ingeschakeld op de MCP server" "Yellow"
        Write-Host "  De server accepteert alleen API keys"
        return
    }

    # Find available port for local callback
    $listener = $null
    $port = 0
    for ($p = 8400; $p -lt 8500; $p++) {
        try {
            $listener = [System.Net.HttpListener]::new()
            $listener.Prefixes.Add("http://localhost:$p/")
            $listener.Start()
            $port = $p
            break
        }
        catch {
            if ($listener) { $listener.Close() }
            $listener = $null
        }
    }

    if (-not $listener) {
        Write-ColorHost "  Kon geen lokale poort openen voor callback" "Red"
        Write-Host "  Probeer handmatige login met: .\mcp-client.ps1 login -Manual"
        return
    }

    $localRedirect = "http://localhost:$port/callback"

    # Generate state for CSRF protection
    $state = [guid]::NewGuid().ToString()

    # Build authorization URL with LOCAL redirect
    $authUrl = "$($config.authorize_url)?" + `
        "client_id=$($config.client_id)" + `
        "&response_type=code" + `
        "&redirect_uri=$([uri]::EscapeDataString($localRedirect))" + `
        "&scope=$([uri]::EscapeDataString($config.scopes))" + `
        "&state=$state"

    Write-ColorHost "`n  Browser opent voor Authentik login..." "Yellow"
    Write-Host "  (wacht op callback op localhost:$port)"
    Write-Host ""

    # Open browser
    Start-Process $authUrl

    # Wait for callback (timeout 120 seconds)
    $listener.AuthenticationSchemes = [System.Net.AuthenticationSchemes]::Anonymous
    $context = $null
    $asyncResult = $listener.BeginGetContext($null, $null)

    $timeout = 120
    $waited = 0
    while (-not $asyncResult.AsyncWaitHandle.WaitOne(1000)) {
        $waited++
        if ($waited -ge $timeout) {
            Write-ColorHost "`n  Timeout - geen login ontvangen binnen $timeout seconden" "Red"
            $listener.Stop()
            $listener.Close()
            return
        }
        Write-Host "`r  Wachten op login... ($waited/$timeout sec)" -NoNewline
    }

    try {
        $context = $listener.EndGetContext($asyncResult)
        $request = $context.Request
        $response = $context.Response

        # Parse query parameters
        $query = $request.Url.Query
        $params = [System.Web.HttpUtility]::ParseQueryString($query)
        $code = $params["code"]
        $returnedState = $params["state"]
        $error = $params["error"]

        if ($error) {
            $response.StatusCode = 400
            $html = "<html><body><h1>Login Mislukt</h1><p>$($params["error_description"])</p></body></html>"
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($html)
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()
            Write-ColorHost "`n  Login mislukt: $error" "Red"
            return
        }

        if ($returnedState -ne $state) {
            $response.StatusCode = 400
            $html = "<html><body><h1>Fout</h1><p>State mismatch - mogelijke CSRF aanval</p></body></html>"
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($html)
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()
            Write-ColorHost "`n  Security fout: state mismatch" "Red"
            return
        }

        # Exchange code for token via MCP server
        Write-Host "`r  Code ontvangen, token ophalen...                    "
        $tokenResponse = Invoke-RestMethod -Uri "$Url/oauth/callback?code=$code&state=$state&format=json" -Method GET -ErrorAction Stop

        if ($tokenResponse.success) {
            # Send success page to browser
            $html = @"
<!DOCTYPE html>
<html>
<head><title>Login Succesvol</title></head>
<body style="font-family:sans-serif;padding:40px;text-align:center;background:#e8f5e9;">
<h1 style="color:#2e7d32;">Login Succesvol!</h1>
<p>Je kunt dit venster sluiten en terug naar PowerShell.</p>
<script>setTimeout(function(){window.close();}, 3000);</script>
</body>
</html>
"@
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($html)
            $response.ContentType = "text/html; charset=utf-8"
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
            $response.Close()

            # Save token
            Save-Token -AccessToken $tokenResponse.access_token `
                       -ExpiresIn $tokenResponse.expires_in `
                       -RefreshToken $tokenResponse.refresh_token

            Write-ColorHost "`n  Login succesvol!" "Green"
            Write-Host "  Token opgeslagen in: $script:TokenFile"
            Write-Host "  Geldig tot: $((Get-Date).AddSeconds($tokenResponse.expires_in).ToString('yyyy-MM-dd HH:mm:ss'))"
            Write-Host ""

            # Ask if user wants to generate permanent API key (only if none exists)
            if (-not (Test-Path $script:ApiKeyFile)) {
                $generateKey = Read-Host "  Wil je een permanente API key genereren voor Claude Desktop? (j/n)"
                if ($generateKey -eq "j" -or $generateKey -eq "y" -or $generateKey -eq "J" -or $generateKey -eq "Y") {
                    Invoke-GenerateApiKey
                } else {
                    Write-Host ""
                    Write-ColorHost "  Tip: Je kunt later alsnog een API key genereren met:" "Yellow"
                    Write-Host "    .\mcp-client.ps1 api-key"
                    Write-Host ""
                }
            }
        }
        else {
            Write-ColorHost "`n  Login mislukt: token exchange failed" "Red"
        }
    }
    catch {
        Write-ColorHost "`n  Fout: $($_.Exception.Message)" "Red"
    }
    finally {
        $listener.Stop()
        $listener.Close()
    }

    Write-Host ""
}

function Show-WhoAmI {
    Write-ColorHost "`n[Login Status]" "Cyan"

    if (-not (Load-Token)) {
        Write-ColorHost "  Niet ingelogd" "Yellow"
        Write-Host "  Gebruik: .\mcp-client.ps1 login"
        Write-Host ""
        return
    }

    if (Test-Path $script:TokenFile) {
        $tokenData = Get-Content $script:TokenFile -Raw | ConvertFrom-Json
        $expires = [DateTime]::Parse($tokenData.expires_at)

        Write-ColorHost "  Status: Ingelogd" "Green"
        Write-Host "  Token file: $script:TokenFile"
        Write-Host "  Geldig tot: $($expires.ToString('yyyy-MM-dd HH:mm:ss'))"

        $remaining = $expires - (Get-Date)
        if ($remaining.TotalMinutes -lt 30) {
            Write-ColorHost "  ⚠ Token verloopt binnenkort!" "Yellow"
        }
    }
    Write-Host ""
}

function Invoke-Logout {
    Write-ColorHost "`n[Logout]" "Cyan"

    if (Test-Path $script:TokenFile) {
        Remove-Token
        Write-ColorHost "  Sessie beeindigd (tijdelijke token verwijderd)" "Green"
    }
    else {
        Write-Host "  Geen actieve sessie"
    }
    Write-Host ""
}

# ============================================
# API KEY GENERATIE
# ============================================

$script:ApiKeyFile = Join-Path $env:USERPROFILE ".mcp-client-apikey"

function Invoke-GenerateApiKey {
    Write-ColorHost "`n[API Key Genereren]" "Cyan"

    # Check if logged in
    if (-not $script:AccessToken) {
        Write-ColorHost "  Je moet eerst inloggen om een API key te genereren." "Yellow"
        Write-Host ""
        Write-Host "  Stappen:"
        Write-Host "    1. .\mcp-client.ps1 login"
        Write-Host "    2. .\mcp-client.ps1 api-key"
        Write-Host ""
        return
    }

    Write-Host "  OAuth token gevonden, API key aanvragen..."

    try {
        $response = Invoke-RestMethod -Uri "$Url/api-key" -Method POST `
            -Headers @{ Authorization = "Bearer $script:AccessToken"; "Content-Type" = "application/json" } `
            -ErrorAction Stop

        if ($response.error) {
            Write-ColorHost "  Fout: $($response.error)" "Red"
            return
        }

        if (-not $response.api_key) {
            Write-ColorHost "  Geen API key ontvangen van server" "Red"
            return
        }

        # Save API key
        $response.api_key | Out-File -FilePath $script:ApiKeyFile -Encoding UTF8 -NoNewline

        # Remove temp token - no longer needed
        if (Test-Path $script:TokenFile) {
            Remove-Token
        }

        Write-ColorHost "`n  API Key succesvol gegenereerd!" "Green"
        Write-Host ""
        Write-Host "  Gebruiker:  $($response.user.email)"
        Write-Host "  Geldig tot: $($response.expires_at)"
        Write-Host "  Opgeslagen: $script:ApiKeyFile"
        Write-Host ""
        Write-ColorHost "  Claude Desktop configuratie:" "Yellow"
        Write-Host ""
        Write-Host "  {"
        Write-Host "    `"mcpServers`": {"
        Write-Host "      `"mcp-server`": {"
        Write-Host "        `"command`": `"npx`","
        Write-Host "        `"args`": [`"-y`", `"@anthropic-ai/mcp-remote`", `"$Url/mcp`"],"
        Write-Host "        `"env`": {"
        Write-Host "          `"MCP_API_KEY`": `"$(Get-Content $script:ApiKeyFile)`""
        Write-Host "        }"
        Write-Host "      }"
        Write-Host "    }"
        Write-Host "  }"
        Write-Host ""
    }
    catch {
        Write-ColorHost "  Fout: $($_.Exception.Message)" "Red"
    }
}

function Show-ApiKeyStatus {
    Write-ColorHost "`n[API Key Status]" "Cyan"

    if (Test-Path $script:ApiKeyFile) {
        $key = Get-Content $script:ApiKeyFile -Raw
        $keyPreview = $key.Substring(0, 20) + "..." + $key.Substring($key.Length - 10)

        Write-ColorHost "  Status:    API key geconfigureerd" "Green"
        Write-Host "  Bestand:   $script:ApiKeyFile"
        Write-Host "  Key:       $keyPreview"
        Write-Host ""
        Write-Host "  Gebruik:   `$env:MCP_API_KEY = Get-Content $script:ApiKeyFile"
    }
    else {
        Write-ColorHost "  Geen API key gevonden" "Yellow"
        Write-Host ""
        Write-Host "  Genereer met: .\mcp-client.ps1 api-key"
    }
    Write-Host ""
}

# Load token on startup
Load-Token | Out-Null

# ============================================
# UPDATE FUNCTIES
# ============================================

function Check-ForUpdate {
    try {
        $response = Invoke-RestMethod -Uri "$Url/version" -Method GET -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.client_version -and $response.client_version -ne $script:Version) {
            Write-Host ""
            Write-ColorHost "  Nieuwe versie beschikbaar: $($response.client_version) (huidige: $script:Version)" "Yellow"
            Write-Host "  Update met: .\mcp-client.ps1 update"
            Write-Host ""
        }
    }
    catch {
        # Silently ignore - don't bother user if check fails
    }
}

function Invoke-Update {
    Write-ColorHost "`n[Update]" "Cyan"

    try {
        # Get current script path
        $scriptPath = $MyInvocation.PSCommandPath
        if (-not $scriptPath) {
            $scriptPath = $PSCommandPath
        }
        if (-not $scriptPath) {
            $scriptPath = Join-Path (Get-Location) "mcp-client.ps1"
        }

        Write-Host "  Huidige versie: $script:Version"
        Write-Host "  Downloaden van: $Url/client"

        # Download new version
        $newScript = Invoke-WebRequest -Uri "$Url/client" -UseBasicParsing -ErrorAction Stop

        # Check version in new script
        if ($newScript.Content -match '\$script:Version = "([^"]+)"') {
            $newVersion = $Matches[1]
            Write-Host "  Nieuwe versie:  $newVersion"

            if ($newVersion -eq $script:Version) {
                Write-ColorHost "`n  Je hebt al de nieuwste versie!" "Green"
                return
            }
        }

        # Save new version
        $newScript.Content | Set-Content -Path $scriptPath -Encoding UTF8

        Write-ColorHost "`n  Update succesvol!" "Green"
        Write-Host "  Herstart het script om de nieuwe versie te gebruiken."
    }
    catch {
        Write-ColorHost "  Update mislukt: $($_.Exception.Message)" "Red"
    }
    Write-Host ""
}

# ============================================
# HELPER FUNCTIES
# ============================================

function Write-ColorHost {
    param([string]$Text, [string]$Color = "White")
    Write-Host $Text -ForegroundColor $Color
}

function Send-McpRequest {
    param(
        [string]$Method,
        [hashtable]$Params = @{}
    )

    $body = @{
        jsonrpc = "2.0"
        id = [int](Get-Date -UFormat %s)
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 10

    try {
        $response = Invoke-WebRequest -Uri "$Url/mcp" -Method POST -Headers $script:Headers -Body $body -UseBasicParsing -ErrorAction Stop

        # Parse SSE response
        $content = $response.Content
        foreach ($line in ($content -split "`n")) {
            if ($line -match "^data: (.+)") {
                return $Matches[1] | ConvertFrom-Json
            }
        }
        return $content | ConvertFrom-Json
    }
    catch {
        $errorMsg = $_.Exception.Message
        if ($errorMsg -match "401|Unauthorized") {
            Write-ColorHost "`n  ⛔ Niet ingelogd - authenticatie vereist" "Yellow"
            Write-Host ""
            Write-Host "  Gebruik eerst:" -ForegroundColor Cyan
            Write-Host "    .\mcp-client.ps1 login" -ForegroundColor White
            Write-Host ""
            Write-Host "  Dit opent je browser voor Authentik SSO login."
            Write-Host ""
        }
        else {
            Write-ColorHost "Error: $errorMsg" "Red"
        }
        return $null
    }
}

function Initialize-McpSession {
    if ($script:Initialized) { return $true }

    $result = Send-McpRequest -Method "initialize" -Params @{
        protocolVersion = "2024-11-05"
        capabilities = @{}
        clientInfo = @{
            name = "mcp-client-powershell"
            version = "1.0.0"
        }
    }

    if ($result.result.serverInfo) {
        $script:Initialized = $true
        return $true
    }
    return $false
}

function Invoke-McpTool {
    param(
        [string]$ToolName,
        [hashtable]$Arguments = @{}
    )

    if (-not (Initialize-McpSession)) {
        # Error already shown by Send-McpRequest
        return $null
    }

    $result = Send-McpRequest -Method "tools/call" -Params @{
        name = $ToolName
        arguments = $Arguments
    }

    if ($result.result.content[0].text) {
        return $result.result.content[0].text | ConvertFrom-Json
    }
    return $null
}

function Show-Help {
    Write-ColorHost "`n╔══════════════════════════════════════════════════════════════╗" "Cyan"
    Write-ColorHost "║              MCP Client - PowerShell                         ║" "Cyan"
    Write-ColorHost "╚══════════════════════════════════════════════════════════════╝" "Cyan"

    Write-ColorHost "`nGEBRUIK:" "Yellow"
    Write-Host "  .\mcp-client.ps1 <command> [parameters]"

    Write-ColorHost "`nCOMMANDO'S:" "Yellow"

    Write-ColorHost "`n  Authenticatie:" "White"
    Write-Host "    login       Login via Authentik SSO (opent browser)"
    Write-Host "    logout      Verwijder opgeslagen tokens"
    Write-Host "    whoami      Toon huidige login status"
    Write-Host "    api-key     Genereer permanente API key (na login)"

    Write-ColorHost "`n  Updates:" "White"
    Write-Host "    update      Download nieuwste versie"
    Write-Host "    version     Toon huidige versie ($script:Version)"

    Write-ColorHost "`n  Informatie:" "White"
    Write-Host "    help        Toon deze hulp"
    Write-Host "    tools       Lijst alle beschikbare MCP tools"
    Write-Host "    health      Controleer MCP server status"

    Write-ColorHost "`n  Packages:" "White"
    Write-Host "    packages    Lijst alle packages"
    Write-Host "    package     Details van package          -Name <naam>"
    Write-Host "    search      Zoek packages                -Query <zoekterm>"

    Write-ColorHost "`n  Services:" "White"
    Write-Host "    status      Service status               -Name <naam>"
    Write-Host "    logs        Service logs                 -Name <naam> [-Lines 50]"
    Write-Host "    ecosystem   Overzicht alle services"

    Write-ColorHost "`n  Redmine:" "White"
    Write-Host "    epics       Lijst epics                  [-Status open|closed|all]"
    Write-Host "    issues      Zoek issues                  [-Query] [-Tracker] [-Status]"
    Write-Host "    issue       Issue details                -Id <nummer>"

    Write-ColorHost "`nVOORBEELDEN:" "Yellow"
    Write-Host "  .\mcp-client.ps1 packages"
    Write-Host "  .\mcp-client.ps1 status -Name n8n"
    Write-Host "  .\mcp-client.ps1 epics -Status all"
    Write-Host "  .\mcp-client.ps1 issue -Id 744"
    Write-Host "  .\mcp-client.ps1 search -Query monitoring"

    Write-ColorHost "`nMCP SERVER:" "Yellow"
    Write-Host "  $Url"
    Write-Host ""
}

# ============================================
# COMMAND HANDLERS
# ============================================

function Show-Health {
    Write-ColorHost "`n[Health Check]" "Cyan"
    try {
        $health = Invoke-RestMethod -Uri "$Url/health" -Method GET -ErrorAction Stop
        Write-ColorHost "  Status:  $($health.status)" "Green"
        Write-ColorHost "  Version: $($health.version)" "White"
    }
    catch {
        Write-ColorHost "  Server niet bereikbaar!" "Red"
        Write-Host "  URL: $Url"
    }
    Write-Host ""
}

function Show-Tools {
    Write-ColorHost "`n[Beschikbare Tools]" "Cyan"

    if (-not (Initialize-McpSession)) {
        Write-ColorHost "  Kan geen verbinding maken" "Red"
        return
    }

    $result = Send-McpRequest -Method "tools/list" -Params @{}

    if ($result.result.tools) {
        $result.result.tools | ForEach-Object {
            Write-ColorHost "  $($_.name)" "Yellow" -NoNewline
            Write-Host " - $($_.description)"
        }
    }
    Write-Host ""
}

function Show-Packages {
    Write-ColorHost "`n[Packages]" "Cyan"

    $data = Invoke-McpTool -ToolName "package_list"

    if ($data.packages) {
        $running = $data.packages | Where-Object { $_.status -eq "running" }
        $stopped = $data.packages | Where-Object { $_.status -eq "stopped" }
        $available = $data.packages | Where-Object { $_.status -eq "available" }

        if ($running) {
            Write-ColorHost "`n  Running:" "Green"
            $running | ForEach-Object { Write-Host "    - $($_.name): $($_.description)" }
        }
        if ($stopped) {
            Write-ColorHost "`n  Stopped:" "Yellow"
            $stopped | ForEach-Object { Write-Host "    - $($_.name): $($_.description)" }
        }
        Write-ColorHost "`n  Available: $($available.Count) packages" "Gray"
    }
    Write-Host ""
}

function Show-Package {
    param([string]$PackageName)

    if (-not $PackageName) {
        Write-ColorHost "  Gebruik: .\mcp-client.ps1 package -Name <naam>" "Yellow"
        return
    }

    Write-ColorHost "`n[Package: $PackageName]" "Cyan"

    $data = Invoke-McpTool -ToolName "package_info" -Arguments @{ name = $PackageName }

    if ($data.error) {
        Write-ColorHost "  $($data.error)" "Red"
    }
    elseif ($data.manifest) {
        Write-Host "  Name:        $($data.manifest.display_name)"
        Write-Host "  Category:    $($data.manifest.category)"
        Write-Host "  Description: $($data.manifest.description)"
        Write-Host "  Status:      $($data.status)"
        if ($data.port) { Write-Host "  Port:        $($data.port)" }
    }
    Write-Host ""
}

function Show-Search {
    param([string]$SearchQuery)

    if (-not $SearchQuery) {
        Write-ColorHost "  Gebruik: .\mcp-client.ps1 search -Query <zoekterm>" "Yellow"
        return
    }

    Write-ColorHost "`n[Zoeken: '$SearchQuery']" "Cyan"

    $data = Invoke-McpTool -ToolName "package_search" -Arguments @{ query = $SearchQuery }

    if ($data.matches) {
        Write-Host "  Gevonden: $($data.total) packages`n"
        $data.matches | ForEach-Object {
            $statusColor = switch ($_.status) { "running" { "Green" } "stopped" { "Yellow" } default { "Gray" } }
            Write-ColorHost "  [$($_.status)]" $statusColor -NoNewline
            Write-Host " $($_.name) - $($_.description)"
        }
    }
    Write-Host ""
}

function Show-Status {
    param([string]$ServiceName)

    if (-not $ServiceName) {
        Write-ColorHost "  Gebruik: .\mcp-client.ps1 status -Name <naam>" "Yellow"
        return
    }

    Write-ColorHost "`n[Service: $ServiceName]" "Cyan"

    $data = Invoke-McpTool -ToolName "service_status" -Arguments @{ name = $ServiceName }

    if ($data) {
        $statusColor = switch ($data.status) { "running" { "Green" } "stopped" { "Yellow" } default { "Red" } }
        Write-Host "  Name:   $($data.name)"
        Write-ColorHost "  Status: $($data.status)" $statusColor
        if ($data.uptime) { Write-Host "  Uptime: $($data.uptime)" }
        if ($data.port) { Write-Host "  Port:   $($data.port)" }
        if ($data.url) { Write-Host "  URL:    $($data.url)" }
    }
    Write-Host ""
}

function Show-Logs {
    param([string]$ServiceName, [int]$LineCount)

    if (-not $ServiceName) {
        Write-ColorHost "  Gebruik: .\mcp-client.ps1 logs -Name <naam> [-Lines 50]" "Yellow"
        return
    }

    Write-ColorHost "`n[Logs: $ServiceName (laatste $LineCount regels)]" "Cyan"

    $data = Invoke-McpTool -ToolName "service_logs" -Arguments @{ name = $ServiceName; lines = $LineCount }

    if ($data.error) {
        Write-ColorHost "  $($data.error)" "Red"
    }
    elseif ($data.logs) {
        $data.logs | ForEach-Object { Write-Host "  $_" }
    }
    Write-Host ""
}

function Show-Ecosystem {
    Write-ColorHost "`n[Ecosystem Health]" "Cyan"

    $data = Invoke-McpTool -ToolName "ecosystem_health"

    if ($data.summary) {
        Write-ColorHost "  Running:   $($data.summary.running)" "Green"
        Write-ColorHost "  Stopped:   $($data.summary.stopped)" "Yellow"
        Write-ColorHost "  Available: $($data.summary.available)" "Gray"
        Write-Host "  ─────────────────"
        Write-Host "  Total:     $($data.summary.total_packages)"
    }
    Write-Host ""
}

function Show-Epics {
    param([string]$StatusFilter)

    Write-ColorHost "`n[Redmine Epics - $StatusFilter]" "Cyan"

    $data = Invoke-McpTool -ToolName "redmine_epics" -Arguments @{ status = $StatusFilter }

    if ($data.error) {
        Write-ColorHost "  $($data.error)" "Red"
    }
    elseif ($data.epics) {
        Write-Host "  Total: $($data.total) epics`n"
        $data.epics | ForEach-Object {
            $statusColor = switch ($_.status) { "New" { "Cyan" } "In Progress" { "Yellow" } "Closed" { "Green" } default { "White" } }
            Write-ColorHost "  #$($_.id)" "White" -NoNewline
            Write-ColorHost " [$($_.status)]" $statusColor -NoNewline
            Write-Host " $($_.subject)"
        }
    }
    Write-Host ""
}

function Show-Issues {
    param([string]$SearchQuery, [string]$TrackerType, [string]$StatusFilter)

    Write-ColorHost "`n[Redmine Issues]" "Cyan"

    $args = @{}
    if ($SearchQuery) { $args.query = $SearchQuery }
    if ($TrackerType) { $args.tracker = $TrackerType }
    if ($StatusFilter) { $args.status = $StatusFilter }

    $data = Invoke-McpTool -ToolName "redmine_issues" -Arguments $args

    if ($data.error) {
        Write-ColorHost "  $($data.error)" "Red"
    }
    elseif ($data.issues) {
        Write-Host "  Total: $($data.total) issues`n"
        $data.issues | ForEach-Object {
            Write-Host "  #$($_.id) [$($_.tracker)] $($_.subject) - $($_.status)"
        }
    }
    Write-Host ""
}

function Show-Issue {
    param([int]$IssueId)

    if ($IssueId -eq 0) {
        Write-ColorHost "  Gebruik: .\mcp-client.ps1 issue -Id <nummer>" "Yellow"
        return
    }

    Write-ColorHost "`n[Issue #$IssueId]" "Cyan"

    $data = Invoke-McpTool -ToolName "redmine_issue" -Arguments @{ id = $IssueId }

    if ($data.error) {
        Write-ColorHost "  $($data.error)" "Red"
    }
    elseif ($data.subject) {
        Write-Host "  Subject:     $($data.subject)"
        Write-Host "  Tracker:     $($data.tracker)"
        Write-Host "  Status:      $($data.status)"
        Write-Host "  Priority:    $($data.priority)"
        Write-Host "  Author:      $($data.author)"
        Write-Host "  Assigned to: $($data.assigned_to)"
        Write-Host "  Created:     $($data.created_on)"
        Write-Host "  Updated:     $($data.updated_on)"

        if ($data.parent) {
            Write-Host "  Parent:      #$($data.parent)"
        }

        if ($data.children -and $data.children.Count -gt 0) {
            Write-ColorHost "`n  Children:" "Yellow"
            $data.children | ForEach-Object {
                Write-Host "    #$($_.id): $($_.subject)"
            }
        }

        if ($data.description) {
            Write-ColorHost "`n  Description:" "Yellow"
            Write-Host "  $($data.description)"
        }
    }
    Write-Host ""
}

# ============================================
# MAIN
# ============================================

# Check for updates (non-blocking, only for certain commands)
if ($Command -notin @("update", "version", "help")) {
    Check-ForUpdate
}

switch ($Command) {
    "update"    { Invoke-Update }
    "version"   { Write-Host "MCP Client v$script:Version" }
    "login"     { Start-OAuthLogin }
    "logout"    { Invoke-Logout }
    "whoami"    { Show-WhoAmI }
    "api-key"   { Invoke-GenerateApiKey }
    "help"      { Show-Help }
    "health"    { Show-Health }
    "tools"     { Show-Tools }
    "packages"  { Show-Packages }
    "package"   { Show-Package -PackageName $Name }
    "search"    { Show-Search -SearchQuery $Query }
    "status"    { Show-Status -ServiceName $Name }
    "logs"      { Show-Logs -ServiceName $Name -LineCount $Lines }
    "ecosystem" { Show-Ecosystem }
    "epics"     { Show-Epics -StatusFilter $Status }
    "issues"    { Show-Issues -SearchQuery $Query -TrackerType $Tracker -StatusFilter $Status }
    "issue"     { Show-Issue -IssueId $Id }
    default     { Show-Help }
}
