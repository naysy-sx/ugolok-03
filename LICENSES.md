# Лицензии сторонних материалов

## Phosphor Icons

Иконки интерфейса (`src/ui/icons/`) — Phosphor Icons, лицензия MIT.
https://github.com/phosphor-icons/core

```
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Файлы генерируются скриптом `scripts/gen-icons.mjs` из ассетов пакета
`@phosphor-icons/core` (devDependency — только исходные SVG, без
исполняемого кода в сборке).

До этого перехода набор иконок был собран вручную из Radix Icons, Feather
Icons и Tabler Icons (все три — MIT), плюс самописные под их геометрию —
эти иконки были частью уже распространявшихся сборок приложения. С
переходом на Phosphor их геометрия из `src/ui/icons/` удалена; запись
об их использовании остаётся в истории git.
