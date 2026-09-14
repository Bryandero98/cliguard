// Package clidump is a minimal, in-repo stand-in for what a real,
// separately published `cliguard-go` package (see issue #9) would provide:
// one function that walks a *cobra.Command tree and prints it as JSON on
// stdout, in a shape cliguard's own --adapter cobra (src/adapters/cobra.adapter.ts)
// knows how to parse. A real target CLI's author would `go get` the real
// package instead of vendoring this file; this PoC exists to prove the
// whole pattern - hidden dump subcommand -> subprocess -> JSON on stdout ->
// mapped into a Contract - works end to end before that package exists.
package clidump

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// requiredAnnotation is the same annotation key Cobra's own
// MarkFlagRequired/MarkPersistentFlagRequired sets internally (it's how
// Cobra's own shell-completion machinery already tracks "this flag is
// required") - reading it back here means required-ness is detected from
// Cobra's own bookkeeping, not re-implemented.
const requiredAnnotation = "cobra_annotation_bash_completion_one_required_flag"

type flagDump struct {
	Name      string `json:"name"`
	Shorthand string `json:"shorthand"`
	Usage     string `json:"usage"`
	DefValue  string `json:"defValue"`
	ValueType string `json:"valueType"`
	Required  bool   `json:"required"`
}

type commandDump struct {
	Name        string        `json:"name"`
	Aliases     []string      `json:"aliases"`
	Short       string        `json:"short"`
	Flags       []flagDump    `json:"flags"`
	Subcommands []commandDump `json:"subcommands"`
}

// dumpCommand only ever reads cmd.LocalFlags() - flags declared exactly at
// this command, not the full merged set `cmd.Flags()` would return once
// Cobra has actually run (which also folds in flags inherited from every
// ancestor) - the same "per-node, not merged" shape cliguard's other
// adapters already report for Commander/CAC/Yargs.
func dumpCommand(cmd *cobra.Command) commandDump {
	flags := []flagDump{}
	cmd.LocalFlags().VisitAll(func(f *pflag.Flag) {
		if f.Name == "help" {
			return
		}
		_, required := f.Annotations[requiredAnnotation]
		flags = append(flags, flagDump{
			Name:      f.Name,
			Shorthand: f.Shorthand,
			Usage:     f.Usage,
			DefValue:  f.DefValue,
			ValueType: f.Value.Type(),
			Required:  required,
		})
	})

	aliases := cmd.Aliases
	if aliases == nil {
		aliases = []string{}
	}

	subcommands := []commandDump{}
	for _, sub := range cmd.Commands() {
		// Never recurse into the dump command itself (cliguard's own
		// integration point) or Cobra's own auto-registered "completion"/
		// "help" commands (framework noise added by Execute() itself, on
		// every Cobra CLI, the same way cliguard's yargs adapter already
		// filters out yargs's own auto-registered --help/--version).
		if (sub.Hidden && sub.Name() == dumpCommandName) || isFrameworkCommand(sub.Name()) {
			continue
		}
		subcommands = append(subcommands, dumpCommand(sub))
	}

	return commandDump{
		Name:        cmd.Name(),
		Aliases:     aliases,
		Short:       cmd.Short,
		Flags:       flags,
		Subcommands: subcommands,
	}
}

const dumpCommandName = "__cliguard_dump__"

func isFrameworkCommand(name string) bool {
	return name == "completion" || name == "help"
}

// NewDumpCommand is the one line a real cliguard-go package would ask a
// Cobra CLI's own author to add: `rootCmd.AddCommand(clidump.NewDumpCommand(rootCmd))`.
// It registers a hidden subcommand that prints root's entire command tree
// as a single JSON object on stdout and exits - cliguard's own cobra
// adapter runs exactly this subcommand as a subprocess and parses that
// output, never anything printed by the target CLI's real commands.
func NewDumpCommand(root *cobra.Command) *cobra.Command {
	return &cobra.Command{
		Use:    dumpCommandName,
		Hidden: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			enc := json.NewEncoder(cmd.OutOrStdout())
			if err := enc.Encode(dumpCommand(root)); err != nil {
				return fmt.Errorf("cliguard dump: %w", err)
			}
			return nil
		},
	}
}
