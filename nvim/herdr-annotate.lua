-- Visual-mode mapping for the herdr-annotate plugin.
-- Upstream: https://github.com/plannotator/herdr-annotate#neovim-integration
--
-- Why this exists on THIS setup: over SSH / `herdr --remote` the plugin runs on
-- the server, and `prefix+a` does not work there -- herdr's copy-on-select
-- clears the selection on mouse-up, and the prefix keypress clears whatever is
-- left before the bound action fires (herdrdev/herdr#3380). A headless login
-- node also has no clipboard to fall back to. This mapping sidesteps the whole
-- keyboard path by handing the selection over in a file, so it is the working
-- path here, not a convenience.
--
-- Select in Visual mode (or with the mouse), then <leader>a. Leader is Space.
-- The file is read once and removed; anything older than 15s is ignored.
vim.keymap.set("x", "<leader>a", function()
  -- Hand the selection to the plugin through a file: works on headless servers too.
  vim.cmd('normal! "zy')
  local base = os.getenv("XDG_RUNTIME_DIR")
  if not base or base == "" then base = vim.fn.fnamemodify(vim.fn.tempname(), ":h") end
  local dir = base .. "/herdr-annotate-" .. vim.loop.getuid()
  vim.fn.mkdir(dir, "p", "0700")
  vim.fn.writefile(vim.split(vim.fn.getreg("z"), "\n"), dir .. "/selection")
  vim.fn.jobstart({ "herdr", "plugin", "action", "invoke", "annotate.capture" })
end, { desc = "Annotate in Herdr" })
