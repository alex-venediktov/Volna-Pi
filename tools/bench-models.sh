#!/usr/bin/env bash
# Одна часть, одна база, семь моделей: сравнение, у которого есть смысл.
#
# Каждая модель делает одну и ту же часть от одного и того же состояния репозитория, в отдельном
# рабочем дереве git. Сравнивать модель A на части 2 с моделью B на части 3 нельзя: части разной
# трудности, и разброс между ними больше разброса между моделями.
#
# Рабочее дерево, а не ветка в основном каталоге: прогон пишет журнал, вику и код, и ни одна из этих
# записей не должна коснуться настоящей работы. Итог прогона выбрасывается целиком - от него нужны
# только числа.
#
#   tools/bench-models.sh <проект> <коммит-база> <номер части> <модель> [ещё модели...]
set -uo pipefail

project=${1:?нужен путь к проекту}
base=${2:?нужен коммит-база}
part=${3:?нужен номер части}
shift 3
[ $# -ge 1 ] || { echo "нужна хотя бы одна модель" >&2; exit 2; }

# Пути приводятся к смешанному виду (D:/...): node понимает его, git-bash тоже, а MSYS-путь вида
# /d/... node на Windows читает как D:\d\... - относительным от корня диска.
win() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project=$(win "$project")
stamp=$(date +%Y%m%d-%H%M%S)
out="$here/bench-$stamp"
mkdir -p "$out"
out=$(win "$out")
here=$(win "$here")

echo "стенд: часть $part от $base, моделей $#" | tee "$out/README.txt"

for model in "$@"; do
	slug=$(printf '%s' "$model" | tr -c 'A-Za-z0-9._-' '-')
	tree="$out/tree-$slug"
	echo
	echo "=== $model ==="
	# Дерево заводится заново на каждую модель: остатки прошлой обнулили бы сравнение.
	git -C "$project" worktree add -q --detach "$tree" "$base" || { echo "не удалось завести дерево" >&2; continue; }
	# База обязана быть с несведённым журналом несовместима: драйвер на такой не стартует, и это
	# правильно - иначе сессия работала бы по устаревшей картине. Проверяем до прогона, чтобы не
	# узнать об этом семь раз подряд.
	# state.json не коммитится, поэтому активную задачу в свежем дереве надо поставить руками.
	node --experimental-strip-types --input-type=module -e "
		import { readFileSync, writeFileSync } from 'node:fs';
		const src = JSON.parse(readFileSync('$project/.volna/state.json', 'utf8'));
		writeFileSync('$tree/.volna/state.json', JSON.stringify(src, null, 2) + '\n');
	" || { echo "активную задачу перенести не вышло" >&2; }

	# Кэш движка не коммитится, и свежее дерево заставило бы каждую модель платить за переимпорт
	# проекта и пересборку кэша имён классов. Это шум, одинаковый для всех и ни о чём не говорящий.
	if [ -d "$project/game/.godot" ] && [ ! -d "$tree/game/.godot" ]; then
		cp -r "$project/game/.godot" "$tree/game/.godot" 2>/dev/null || true
	fi

	# --no-capture: вывод по задаче - отдельная сессия на закрытой очереди, и платит за неё только
	# та модель, что дошла до конца. В сравнении одной части ей места нет.
	log="$out/$slug.log"
	jsonl="$out/$slug.jsonl"
	node --experimental-strip-types "$here/tools/plan-run.ts" \
		--dir "$tree" --until "$part" --model "$model" --no-capture --transcript "$jsonl" >"$log" 2>&1
	node "$here/tools/bench-metrics.mjs" "$log" "$jsonl" "$model" > "$out/$slug.json"
	cat "$out/$slug.json"

	git -C "$project" worktree remove --force "$tree" 2>/dev/null || true
done

echo
echo "=== сводка ==="
node -e "
const fs=require('fs');
const rows=fs.readdirSync('$out').filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync('$out/'+f,'utf8')));
console.table(rows.map(r=>({модель:r.модель,вызовов:r.вызовов,минут:r.минут,прерываний:r['прерываний сторожем'],ошибок:r['ошибок инструментов'],итог:String(r.итог).slice(0,40)})));
"
echo "числа: $out"
