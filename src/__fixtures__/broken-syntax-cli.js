// Deliberately invalid JS - used to verify that a syntax error in the
// target file surfaces as an actual syntax error, not the generic
// "no Command instance found" message (which would misleadingly suggest
// the file loaded fine and just exported the wrong thing).
const { Command } = require("commander");
const program = new Command(
module.exports = { program };
