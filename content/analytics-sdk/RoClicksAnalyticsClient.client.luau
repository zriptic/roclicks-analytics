--[[
	RoClicks Analytics device reporter. Optional.

	Put this LocalScript in StarterPlayer > StarterPlayerScripts. It tells
	the server SDK once per visit whether the player is on a phone, tablet,
	computer, console or VR headset, so the dashboard can split sessions by
	device. Nothing else is sent, and it needs no setup.
]]

local GuiService = game:GetService("GuiService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")
local VRService = game:GetService("VRService")

local remote = ReplicatedStorage:WaitForChild("RoClicksAnalyticsDevice", 30)
if not remote then
	return -- the server SDK isn't set up in this game
end

local function deviceType(): string
	if VRService.VREnabled then
		return "vr"
	end
	if GuiService:IsTenFootInterface() then
		return "console"
	end
	if UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled then
		-- Phones are under ~500 px on their short side; tablets are bigger.
		local camera = workspace.CurrentCamera
		while camera and camera.ViewportSize.X <= 1 do
			task.wait(0.1)
		end
		local size = if camera then camera.ViewportSize else Vector2.new(1000, 1000)
		return if math.min(size.X, size.Y) < 500 then "phone" else "tablet"
	end
	return "desktop"
end

remote:FireServer(deviceType())
