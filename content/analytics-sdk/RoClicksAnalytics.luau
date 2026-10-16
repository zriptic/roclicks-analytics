--!strict
--[[
	RoClicks Analytics SDK for Roblox. Free, from https://roclicks.gg/analytics

	Put this ModuleScript in ServerScriptService (or ServerStorage) and call
	Setup once from a server Script:

		local Analytics = require(game.ServerScriptService.RoClicksAnalytics)
		Analytics.Setup({ key = "rca_..." })

		Analytics.Track(player, "ShopOpened")
		Analytics.Track(player, "Purchase", { item = "Sword", robux = 99 })
		Analytics.Track(nil, "RoundStarted", { map = "Desert" })

		local coins = Analytics.Config.Get("starterCoins", 50)
		Analytics.Config.Changed:Connect(function(values) ... end)

		-- A/B tests: pass the player, and a running test on that key hands
		-- each player their own variant (the same one on every server).
		local coins = Analytics.Config.Get("starterCoins", 50, player)

		-- Revenue: wrap your ProcessReceipt so granted developer products are
		-- recorded with the exact Robux paid. Game passes are tracked on
		-- their own.
		MarketplaceService.ProcessReceipt = Analytics.WrapProcessReceipt(function(receipt)
			...
			return Enum.ProductPurchaseDecision.PurchaseGranted
		end)

	Needs Game Settings > Security > Allow HTTP Requests.

	Optional: put RoClicksAnalyticsClient (a LocalScript) in
	StarterPlayerScripts to split sessions by phone, tablet, computer,
	console and VR. The server can't tell devices apart on its own.

	What it sends by itself: a session start when a player joins and an end
	when they leave (that's DAU, retention and session length), plus a
	heartbeat every flush so crashed servers don't leave sessions open.
	Markers you send with Track() are the only thing that counts toward the
	monthly quota; sales never do. Studio playtests go to a separate
	"studio" environment.

	Sales are sent as the Robux the player paid. The dashboard subtracts
	Roblox's cut (you keep 70% of passes, products, private servers and
	subscriptions, 40% of avatar items sold in your game) and converts what
	you keep to USD at your DevEx rate.
]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local LocalizationService = game:GetService("LocalizationService")
local DataStoreService = game:GetService("DataStoreService")
local MarketplaceService = game:GetService("MarketplaceService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local VERSION = "1.2.0"
local DEFAULT_URL = "https://roclicks.gg/api/a/v1"
local MAX_QUEUED_EVENTS = 5000
local MAX_EVENTS_PER_BATCH = 1000
local SHUTDOWN_BUDGET = 20 -- seconds of BindToClose we're willing to use

type Options = {
	key: string,
	url: string?,
	flushInterval: number?,
	debug: boolean?,
	trackPositions: boolean?,
	trackGamePasses: boolean?,
}

type PurchaseInfo = {
	kind: ("product" | "pass" | "subscription" | "private_server" | "avatar_item" | "other")?,
	robux: number,
	itemId: number?,
	name: string?,
	id: string?,
}

type Session = { id: string, userId: number, device: boolean? }

type Variant = { name: string, value: any, weight: number }
type Experiment = { id: string, key: string, variants: { Variant } }

--------------------------------------------------------------------------
-- A tiny signal, so the module has no dependencies.
--------------------------------------------------------------------------

type Connection = { Disconnect: (Connection) -> () }
type Signal = {
	Connect: (Signal, (...any) -> ()) -> Connection,
	_fire: (Signal, ...any) -> (),
}

local function newSignal(): Signal
	local handlers: { [number]: (...any) -> () } = {}
	local nextId = 0
	local signal = {} :: any
	function signal:Connect(fn)
		nextId += 1
		local id = nextId
		handlers[id] = fn
		return {
			Disconnect = function()
				handlers[id] = nil
			end,
		}
	end
	function signal:_fire(...)
		for _, fn in handlers do
			task.spawn(fn, ...)
		end
	end
	return signal
end

--------------------------------------------------------------------------
-- State
--------------------------------------------------------------------------

local Analytics = {}
Analytics.VERSION = VERSION

local opts: Options? = nil
local env = RunService:IsStudio() and "studio" or "prod"
local sessions: { [Player]: Session } = {}

local startedQueue: { any } = {}
local endedQueue: { any } = {}
local eventQueue: { any } = {}
local purchaseQueue: { any } = {}
local exposureQueue: { any } = {}
local deviceQueue: { any } = {}

local configValues: { [string]: any } = {}
local configVersion = -1 -- -1 = never loaded
local configLoaded = false
local configLoadedSignal = newSignal()
local experiments: { [string]: Experiment } = {} -- running A/B tests by config key
local exposed: { [number]: { [string]: boolean } } = {} -- userId -> tests already reported this visit
local stopped = false
local warnedOnce: { [string]: boolean } = {}

local function warnOnce(tag: string, message: string)
	if warnedOnce[tag] then
		return
	end
	warnedOnce[tag] = true
	warn("[RoClicksAnalytics] " .. message)
end

local function debugLog(message: string)
	if opts and opts.debug then
		print("[RoClicksAnalytics] " .. message)
	end
end

local function now(): number
	return workspace:GetServerTimeNow()
end

--------------------------------------------------------------------------
-- HTTP
--------------------------------------------------------------------------

-- Returns (ok, decodedBody, statusCode). ok is false on network errors and
-- non-2xx responses; statusCode is 0 when the request never got an answer.
local function request(method: string, path: string, body: any?): (boolean, any, number)
	local o = opts :: Options
	local success, response = pcall(function()
		return HttpService:RequestAsync({
			Url = (o.url or DEFAULT_URL) .. path,
			Method = method,
			Headers = {
				["Content-Type"] = "application/json",
				["x-rc-key"] = o.key,
				["x-rc-env"] = env,
				["x-rc-sdk"] = "roblox/" .. VERSION,
			},
			Body = if body ~= nil then HttpService:JSONEncode(body) else nil,
		})
	end)
	if not success then
		local message = tostring(response)
		if string.find(message, "Http requests are not enabled", 1, true) then
			warnOnce("http", "HTTP requests are off. Turn on Game Settings > Security > Allow HTTP Requests.")
		else
			debugLog("request failed: " .. message)
		end
		return false, nil, 0
	end
	local decoded = nil
	pcall(function()
		decoded = HttpService:JSONDecode(response.Body)
	end)
	return response.Success, decoded, response.StatusCode
end

--------------------------------------------------------------------------
-- Config
--------------------------------------------------------------------------

local Config = {}
Config.Changed = newSignal()
Analytics.Config = Config

-- The last config that loaded is kept in a DataStore, so a server that
-- starts while the API is unreachable still gets real values instead of
-- every default.
local backupStore: DataStore? = nil
pcall(function()
	backupStore = DataStoreService:GetDataStore("RoClicksAnalytics_Config")
end)

local function readExperiments(list: any): { [string]: Experiment }
	local byKey: { [string]: Experiment } = {}
	if typeof(list) ~= "table" then
		return byKey
	end
	for _, exp in list do
		if typeof(exp) == "table" and typeof(exp.id) == "string" and typeof(exp.key) == "string" and typeof(exp.variants) == "table" and #exp.variants > 0 then
			byKey[exp.key] = exp
		end
	end
	return byKey
end

local function applyConfig(values: any, version: number, fromBackup: boolean, experimentList: any)
	if typeof(values) ~= "table" then
		return
	end
	local changed = version ~= configVersion
	configValues = values
	configVersion = version
	experiments = readExperiments(experimentList)
	if not configLoaded then
		configLoaded = true
		configLoadedSignal:_fire()
	end
	if changed then
		debugLog(`config v{version} applied{if fromBackup then " (from backup)" else ""}`)
		Config.Changed:_fire(values, version)
	end
end

local function fetchConfig(): boolean
	local ok, body = request("GET", "/config")
	if ok and typeof(body) == "table" and typeof(body.values) == "table" then
		applyConfig(body.values, tonumber(body.version) or 0, false, body.experiments)
		if backupStore and not RunService:IsStudio() then
			task.spawn(pcall, function()
				(backupStore :: DataStore):SetAsync(env, { version = body.version, values = body.values, experiments = body.experiments })
			end)
		end
		return true
	end
	return false
end

local function loadBackup()
	if not backupStore then
		return
	end
	local ok, saved = pcall(function()
		return (backupStore :: DataStore):GetAsync(env)
	end)
	if ok and typeof(saved) == "table" and not configLoaded then
		applyConfig(saved.values, tonumber(saved.version) or 0, true, saved.experiments)
	end
end

-- FNV-1a, 32 bit. The dashboard runs the same function to check which
-- variant each player got, so the two must never differ.
local function fnv1a(text: string): number
	local h = 2166136261
	for i = 1, #text do
		h = bit32.bxor(h, string.byte(text, i))
		-- h * 16777619 mod 2^32, split as 2^24 + 403 so no bits are lost
		h = (bit32.lshift(h, 24) + h * 403) % 4294967296
	end
	return h
end

local function pickVariant(exp: Experiment, userId: number): Variant
	local bucket = fnv1a(exp.id .. ":" .. tostring(userId)) % 10000
	local total = 0
	for _, v in exp.variants do
		total += v.weight
	end
	local acc = 0
	for _, v in exp.variants do
		acc += v.weight
		if bucket < math.floor(acc * 10000 / total) then
			return v
		end
	end
	return exp.variants[#exp.variants]
end

-- The first time a player is handed a variant, tell the API, so results
-- only count what they did from then on.
local function noteExposure(exp: Experiment, player: Player)
	local seen = exposed[player.UserId]
	if not seen then
		seen = {}
		exposed[player.UserId] = seen
	end
	if seen[exp.id] then
		return
	end
	seen[exp.id] = true
	if #exposureQueue < MAX_QUEUED_EVENTS then
		table.insert(exposureQueue, { e = exp.id, userId = player.UserId, t = now() })
	end
end

-- Read a value. `path` is a key or a dotted path ("shop.prices.sword").
-- Returns `default` when the key is missing or the config hasn't loaded.
-- Pass `player` to take part in A/B tests: if a test is running on exactly
-- this key, the player gets their variant's value instead.
function Config.Get(path: string, default: any?, player: Player?): any
	if player then
		local exp = experiments[path]
		if exp then
			local variant = pickVariant(exp, player.UserId)
			noteExposure(exp, player)
			if variant.value ~= nil then
				return variant.value
			end
		end
	end
	local node: any = configValues
	for part in string.gmatch(path, "[^%.]+") do
		if typeof(node) ~= "table" then
			return default
		end
		node = node[part]
	end
	if node == nil then
		return default
	end
	return node
end

-- The whole config table. Treat it as read-only.
function Config.GetAll(): { [string]: any }
	return configValues
end

-- Yields until the first config arrives (or `timeout` seconds, default 10).
-- Returns false on timeout; Get() then hands back defaults.
function Config.WaitForLoad(timeout: number?): boolean
	if configLoaded then
		return true
	end
	local done = false
	local conn = configLoadedSignal:Connect(function()
		done = true
	end)
	local deadline = os.clock() + (timeout or 10)
	while not done and os.clock() < deadline do
		task.wait(0.1)
	end
	conn:Disconnect()
	return configLoaded
end

-- Name of the variant `player` is in for the test on `key`, or nil when no
-- test is running there. Use it to branch on more than one value:
--   if Analytics.Config.GetVariant(player, "newShop") == "B" then ... end
function Config.GetVariant(player: Player, key: string): string?
	local exp = experiments[key]
	if not exp then
		return nil
	end
	noteExposure(exp, player)
	return pickVariant(exp, player.UserId).name
end

function Config.Version(): number
	return configVersion
end

--------------------------------------------------------------------------
-- Markers
--------------------------------------------------------------------------

local function encodePosition(position: any): { number }?
	if typeof(position) == "Vector3" then
		return { position.X, position.Y, position.Z }
	elseif typeof(position) == "CFrame" then
		local p = position.Position
		return { p.X, p.Y, p.Z }
	end
	return nil
end

local function characterPosition(player: Player): { number }?
	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if root and root:IsA("BasePart") then
		return encodePosition(root.Position)
	end
	return nil
end

-- Record a marker. Pass a player for a player marker or nil for a global
-- one. `value` is any JSON-able value (number, string, table). `position`
-- is a Vector3 or CFrame; for player markers it defaults to where their
-- character is standing, which is what heatmaps will read.
function Analytics.Track(player: Player?, name: string, value: any?, position: (Vector3 | CFrame)?)
	if typeof(name) ~= "string" or not string.match(name, "^[%w_ %.:/%-]+$") or #name > 64 then
		warnOnce("name:" .. tostring(name), `marker name "{tostring(name)}" must be 1-64 letters, digits, spaces or _ . : / -`)
		return
	end
	local event: { [string]: any } = { name = name, t = now() }
	if value ~= nil then
		event.value = value
	end
	if player then
		event.userId = player.UserId
		local session = sessions[player]
		if session then
			event.sessionId = session.id
		end
	end
	event.pos = encodePosition(position)
	if not event.pos and player and (not opts or opts.trackPositions ~= false) then
		event.pos = characterPosition(player)
	end

	if #eventQueue >= MAX_QUEUED_EVENTS then
		table.remove(eventQueue, 1)
		warnOnce("queue", "marker queue is full; the oldest markers are being dropped")
	end
	table.insert(eventQueue, event)
end

function Analytics.GetSessionId(player: Player): string?
	local session = sessions[player]
	return session and session.id
end

--------------------------------------------------------------------------
-- Revenue
--------------------------------------------------------------------------

local productNames: { [string]: string } = {}

-- Fills entry.name from the catalog, cached. Runs in the background so it
-- never delays granting a purchase; the name just has to arrive before the
-- next flush to be included.
local function fillName(entry: { [string]: any }, infoType: Enum.InfoType)
	if entry.name or not entry.itemId then
		return
	end
	local cacheKey = tostring(infoType) .. entry.itemId
	if productNames[cacheKey] then
		entry.name = productNames[cacheKey]
		return
	end
	task.spawn(function()
		local ok, info = pcall(MarketplaceService.GetProductInfo, MarketplaceService, entry.itemId, infoType)
		if ok and typeof(info) == "table" and typeof(info.Name) == "string" then
			productNames[cacheKey] = info.Name
			entry.name = info.Name
		end
	end)
end

local function queuePurchase(userId: number, info: PurchaseInfo): { [string]: any }?
	if typeof(info) ~= "table" or typeof(info.robux) ~= "number" or info.robux < 0 then
		warnOnce("purchase", "TrackPurchase needs { robux = <Robux the player paid> }")
		return nil
	end
	local entry: { [string]: any } = {
		id = info.id or HttpService:GenerateGUID(false),
		userId = userId,
		kind = info.kind or "other",
		robux = math.floor(info.robux),
		itemId = info.itemId,
		name = info.name,
		t = now(),
	}
	local player = Players:GetPlayerByUserId(userId)
	if player and sessions[player] then
		entry.sessionId = sessions[player].id
	end
	table.insert(purchaseQueue, entry)
	return entry
end

-- Record a sale the SDK can't see on its own: subscriptions, private
-- servers, avatar items sold in your game, or anything else. `robux` is
-- what the player paid, before Roblox's cut.
function Analytics.TrackPurchase(player: Player, info: PurchaseInfo)
	queuePurchase(player.UserId, info)
end

-- Wraps your ProcessReceipt handler. Only purchases your handler GRANTS are
-- recorded, with receipt.CurrencySpent (the exact Robux paid, regional
-- prices and price tests included). Roblox retries receipts you don't
-- grant; the PurchaseId keeps a retried-then-granted receipt from counting
-- twice.
function Analytics.WrapProcessReceipt(handler: (receiptInfo: any) -> Enum.ProductPurchaseDecision)
	return function(receiptInfo: any): Enum.ProductPurchaseDecision
		local decision = handler(receiptInfo)
		if decision == Enum.ProductPurchaseDecision.PurchaseGranted then
			local entry = queuePurchase(receiptInfo.PlayerId, {
				kind = "product",
				robux = tonumber(receiptInfo.CurrencySpent) or 0,
				itemId = receiptInfo.ProductId,
				id = "receipt:" .. tostring(receiptInfo.PurchaseId),
			})
			if entry then
				fillName(entry, Enum.InfoType.Product)
			end
		end
		return decision
	end
end

local function onGamePassPurchase(player: Player, gamePassId: number, wasPurchased: boolean)
	if not wasPurchased then
		return
	end
	-- The receipt-less pass flow only tells us the pass, so the price is
	-- the pass's list price. A regional price can differ slightly.
	task.spawn(function()
		local ok, info = pcall(MarketplaceService.GetProductInfo, MarketplaceService, gamePassId, Enum.InfoType.GamePass)
		local price = if ok and typeof(info) == "table" then tonumber(info.PriceInRobux) else nil
		if not price then
			warnOnce("passprice", `couldn't read the price of pass {gamePassId}; that sale wasn't recorded`)
			return
		end
		queuePurchase(player.UserId, {
			kind = "pass",
			robux = price,
			itemId = gamePassId,
			name = if typeof(info.Name) == "string" then info.Name else nil,
		})
	end)
end

--------------------------------------------------------------------------
-- Sessions
--------------------------------------------------------------------------

local function startSession(player: Player)
	if sessions[player] then
		return
	end
	local session = { id = HttpService:GenerateGUID(false), userId = player.UserId }
	sessions[player] = session
	local entry: { [string]: any } = { id = session.id, userId = session.userId, t = now() }
	table.insert(startedQueue, entry)
	-- Country is filled in if it arrives before the next flush.
	task.spawn(function()
		local ok, country = pcall(LocalizationService.GetCountryRegionForPlayerAsync, LocalizationService, player)
		if ok and typeof(country) == "string" then
			entry.country = country
		end
	end)
end

local DEVICES = { phone = true, tablet = true, desktop = true, console = true, vr = true }

-- From the optional client script. Each session takes one answer; anything
-- else a client sends is ignored.
local function onDevice(player: Player, device: any)
	local session = sessions[player]
	if not session or session.device or typeof(device) ~= "string" or not DEVICES[device] then
		return
	end
	session.device = true
	table.insert(deviceQueue, { id = session.id, device = device })
end

local function endSession(player: Player)
	local session = sessions[player]
	if not session then
		return
	end
	sessions[player] = nil
	exposed[session.userId] = nil
	table.insert(endedQueue, { id = session.id, t = now() })
end

--------------------------------------------------------------------------
-- Flushing
--------------------------------------------------------------------------

local flushing = false
-- Set when the API answers 429: no regular flush before this os.clock() time.
local backoffUntil = 0

local function takeAll(queue: { any }): { any }
	local taken = table.clone(queue)
	table.clear(queue)
	return taken
end

local function putBack(queue: { any }, items: { any })
	-- Failed items go back in front, keeping their order.
	for i = #items, 1, -1 do
		table.insert(queue, 1, items[i])
	end
end

-- Send everything queued. Returns true if the server accepted the batch.
function Analytics.Flush(): boolean
	if not opts or flushing then
		return false
	end
	flushing = true

	local started = takeAll(startedQueue)
	local ended = takeAll(endedQueue)
	local events = {}
	for _ = 1, math.min(#eventQueue, MAX_EVENTS_PER_BATCH) do
		table.insert(events, table.remove(eventQueue, 1))
	end
	local purchases = takeAll(purchaseQueue)
	local exposures = takeAll(exposureQueue)
	local devices = takeAll(deviceQueue)
	local active = {}
	for _, session in sessions do
		table.insert(active, session.id)
	end

	local ok, body, status = request("POST", "/ingest", {
		serverId = if game.JobId ~= "" then game.JobId else "studio",
		placeId = game.PlaceId,
		started = started,
		ended = ended,
		active = active,
		events = events,
		purchases = purchases,
		exposures = exposures,
		devices = devices,
	})

	if ok then
		if typeof(body) == "table" then
			if (tonumber(body.rejected) or 0) > 0 and typeof(body.reasons) == "table" then
				warnOnce("rejected:" .. table.concat(body.reasons, ";"), `some markers were rejected: {table.concat(body.reasons, "; ")}`)
			end
			local remoteVersion = tonumber(body.configVersion)
			if remoteVersion and remoteVersion ~= configVersion then
				task.spawn(fetchConfig)
			end
		end
		debugLog(`flushed {#events} markers, {#started} joins, {#ended} leaves`)
	elseif status == 429 then
		-- Rate limited: keep everything and wait as long as the API asks.
		putBack(startedQueue, started)
		putBack(endedQueue, ended)
		putBack(eventQueue, events)
		putBack(purchaseQueue, purchases)
		putBack(exposureQueue, exposures)
		putBack(deviceQueue, devices)
		local wait = if typeof(body) == "table" then tonumber(body.retryAfter) else nil
		backoffUntil = os.clock() + math.clamp(wait or 30, 1, 300)
		debugLog(`rate limited; pausing flushes for {math.floor(backoffUntil - os.clock())}s`)
	elseif status == 401 then
		warnOnce("key", "the SDK key was refused. Copy it again from roclicks.gg/analytics.")
	elseif status >= 400 and status < 500 then
		-- The batch itself is bad; retrying it would fail forever.
		warnOnce("4xx", `a batch was refused with HTTP {status} and dropped`)
	else
		putBack(startedQueue, started)
		putBack(endedQueue, ended)
		putBack(eventQueue, events)
		putBack(purchaseQueue, purchases)
		putBack(exposureQueue, exposures)
		putBack(deviceQueue, devices)
	end

	flushing = false
	return ok
end

--------------------------------------------------------------------------
-- Setup
--------------------------------------------------------------------------

function Analytics.Setup(options: Options)
	assert(RunService:IsServer(), "RoClicksAnalytics.Setup must be called from a server Script")
	assert(typeof(options) == "table" and typeof(options.key) == "string", "RoClicksAnalytics.Setup needs { key = \"rca_...\" }")
	if opts then
		warnOnce("setup", "Setup was called twice; the second call is ignored")
		return
	end
	opts = options
	local interval = math.max(5, options.flushInterval or (if env == "studio" then 5 else 15))

	for _, player in Players:GetPlayers() do
		startSession(player)
	end
	Players.PlayerAdded:Connect(startSession)
	Players.PlayerRemoving:Connect(endSession)
	local deviceRemote = ReplicatedStorage:FindFirstChild("RoClicksAnalyticsDevice")
	if not deviceRemote then
		deviceRemote = Instance.new("RemoteEvent")
		deviceRemote.Name = "RoClicksAnalyticsDevice"
		deviceRemote.Parent = ReplicatedStorage
	end
	;(deviceRemote :: RemoteEvent).OnServerEvent:Connect(onDevice)
	if options.trackGamePasses ~= false then
		MarketplaceService.PromptGamePassPurchaseFinished:Connect(onGamePassPurchase)
	end

	task.spawn(function()
		if not fetchConfig() then
			loadBackup()
			-- Keep trying in the background; ingest will also trigger a
			-- fetch once the API answers.
		end
	end)

	task.spawn(function()
		while not stopped do
			task.wait(interval)
			if not stopped and os.clock() >= backoffUntil then
				Analytics.Flush()
			end
		end
	end)

	game:BindToClose(function()
		stopped = true
		for player in sessions do
			endSession(player)
		end
		local deadline = os.clock() + SHUTDOWN_BUDGET
		repeat
			while flushing and os.clock() < deadline do
				task.wait(0.1)
			end
			if not Analytics.Flush() then
				task.wait(1)
			end
		until (#eventQueue == 0 and #startedQueue == 0 and #endedQueue == 0 and #purchaseQueue == 0 and #exposureQueue == 0 and #deviceQueue == 0) or os.clock() >= deadline
	end)

	debugLog(`started in {env} mode, flushing every {interval}s`)
end

return Analytics
