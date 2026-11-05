#!/usr/bin/env python3
"""Install personal skills locally; opt in to pi packages and extensions."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess

ROOT = Path(__file__).resolve().parent
HOME_DIR = Path(os.environ.get('AGENT_STUFF_HOME', str(Path.home()))).expanduser()


def link(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() and target.resolve() == source.resolve():
        return
    if target.exists() or target.is_symlink():
        print(f'Preserving existing entry: {target}')
        return
    target.symlink_to(source, target_is_directory=source.is_dir())
    print(f'Linked {target}')


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, help='Alternative home directory for skill and prompt links')
    modes = parser.add_mutually_exclusive_group()
    for mode in ('skills', 'prompts', 'forks', 'packages'):
        modes.add_argument('--' + mode, action='store_true')
    args = parser.parse_args()
    global HOME_DIR
    if args.home:
        if args.packages or args.forks:
            parser.error('--home applies only to skills and prompts')
        HOME_DIR = args.home.expanduser().resolve()
    if args.prompts:
        for source in (ROOT / 'prompts').glob('*.md'):
            link(source, HOME_DIR / '.pi/agent/prompts' / source.name)
    elif args.forks:
        pi = os.environ.get('PI', 'pi')
        for source in sorted((ROOT / 'extensions').iterdir()):
            if not (source / 'package.json').exists() or (source / '.disabled').exists():
                continue
            if source.name == 'cmux-pi' and platform.system() != 'Darwin':
                continue
            run('npm', 'install', '--package-lock=false', cwd=source)
            run(pi, 'install', str(source))
    elif args.packages:
        pi = os.environ.get('PI', 'pi')
        for line in (ROOT / 'pi-packages.txt').read_text().splitlines():
            line = line.split('#', 1)[0].strip()
            if not line:
                continue
            tag, _, package = line.partition(' ')
            if tag == '@remove':
                print(f'If installed, remove conflicting package with: {pi} remove {package}')
                continue
            if tag == '@darwin':
                if platform.system() != 'Darwin':
                    continue
                line = package
            elif tag == '@npm-global':
                run('npm', 'install', '-g', '--prefix', str(HOME_DIR / '.local'), package)
                continue
            elif tag == '@cargo':
                name, version = package.rsplit('@', 1)
                run('cargo', 'install', name, '--version', version, '--locked', '--root', str(HOME_DIR / '.local'))
                continue
            elif tag == '@no-extensions':
                line = package
            run(pi, 'install', line)
            if tag == '@no-extensions':
                settings = Path.home() / '.pi/agent/settings.json'
                data = json.loads(settings.read_text())
                base = package.rsplit('@', 1)[0]
                for i, entry in enumerate(data.get('packages', [])):
                    src = entry if isinstance(entry, str) else entry.get('source', '')
                    if src == base or src == package or src.startswith(base + '@'):
                        data['packages'][i] = {**(entry if isinstance(entry, dict) else {}), 'source': src, 'extensions': []}
                settings.write_text(json.dumps(data, indent=2) + '\n')
    else:
        for source in sorted((ROOT / 'skills').iterdir()):
            if not (source / 'SKILL.md').exists():
                continue
            for dest in ('.agents/skills', '.claude/skills', '.cursor/skills', '.grok/skills'):
                link(source, HOME_DIR / dest / source.name)


if __name__ == '__main__':
    main()
