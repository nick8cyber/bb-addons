# bb-addons

Custom themes and plugins for [bb](https://getbb.app).

## Plugins

### `ru` — Русификатор

Переводит интерфейс bb на русский язык: 2337 строк словаря, точное совпадение,
переписка и код не затрагиваются. Подробности, замер покрытия и порядок
пополнения словаря — в [plugins/bb-plugin-ru/README.md](plugins/bb-plugin-ru/README.md).

```bash
bb plugin install git:https://github.com/nick8cyber/bb-addons.git@main --plugin ru
```

Или из локального клона:

```bash
bb plugin install ./plugins/bb-plugin-ru
```

Кнопка-глобус в подвале боковой панели переключает язык на месте.

## Themes

- `arctic-ledger` — a high-contrast blue light theme with a matching dark appearance.

Install it by copying `themes/arctic-ledger` into the directory printed by `bb theme dir`, then run:

```bash
bb theme set arctic-ledger
```
