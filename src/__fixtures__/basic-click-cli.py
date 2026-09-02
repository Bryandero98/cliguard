# A real Click program used as test input for ClickAdapter - exercises a
# root group with its own option, a nested group (group inside a group),
# a required option, a repeatable ("multiple") option, a required
# positional argument, a variadic positional argument, and a choice
# option with a default.
import click


@click.group(help="Sample root group")
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose output")
def cli(verbose):
    pass


@cli.command(help="Build the project")
@click.option("--output", "-o", required=True, help="Output path")
@click.option("--tag", multiple=True, help="Tag to attach")
@click.argument("target", required=True)
@click.argument("extra", required=False, nargs=-1)
def build(output, tag, target, extra):
    pass


@cli.group(help="Nested subgroup")
def sub():
    pass


@sub.command(name="deploy")
@click.option("--env", type=click.Choice(["prod", "staging"]), default="staging", help="Target env")
def sub_deploy(env):
    pass


if __name__ == "__main__":
    cli()
