// Command cobra-dump is a tiny example Cobra CLI - the PoC target for
// cliguard's --adapter cobra (see src/adapters/cobra.adapter.ts and issue
// #9). It exists only to prove the adapter's whole pattern works end to
// end: a hidden `__cliguard_dump__` subcommand (wired in via
// clidump.NewDumpCommand, one line below) prints this CLI's real command
// tree as JSON, and cliguard runs it as a subprocess and parses that
// output - the same shape as a real target CLI a maintainer would point
// cliguard at, once a real `cliguard-go` package exists to replace the
// local clidump package.
package main

import (
	"fmt"
	"os"

	"github.com/Bryandero98/cliguard/examples/cobra-dump/clidump"
	"github.com/spf13/cobra"
)

func main() {
	var target string
	var verbose bool
	var tags []string

	rootCmd := &cobra.Command{
		Use:   "greet",
		Short: "A tiny example CLI",
	}

	buildCmd := &cobra.Command{
		Use:     "build",
		Aliases: []string{"b"},
		Short:   "Build the project",
		Run: func(_ *cobra.Command, args []string) {
			fmt.Printf("building target=%q verbose=%v tags=%v args=%v\n", target, verbose, tags, args)
		},
	}
	buildCmd.Flags().StringVarP(&target, "target", "t", "", "build target")
	if err := buildCmd.MarkFlagRequired("target"); err != nil {
		panic(err)
	}
	buildCmd.Flags().BoolVar(&verbose, "verbose", false, "verbose logging")
	buildCmd.Flags().StringSliceVar(&tags, "tag", nil, "tag to attach (repeatable)")

	rootCmd.AddCommand(buildCmd)

	// The one-line integration a real cliguard-go package would ask this
	// CLI's own author to add - see clidump.NewDumpCommand's doc comment.
	rootCmd.AddCommand(clidump.NewDumpCommand(rootCmd))

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
