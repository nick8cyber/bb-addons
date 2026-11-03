---
title: Поддерживаемый форк в bb-addons Server Switcher
status: accepted
date: 2026-11-02
---

# Поддерживаемый форк в bb-addons Server Switcher

Исходный плагин вызывает strip.open() при регистрации, а footer рисует цветной аватар вместо стандартной пиктограммы. Используем локальный source-backed форк того же pluginId: native disclosure без принудительного открытия, стандартный outline icon. Логика server selection, pairing и rings остаётся исходной. По прямому указанию владельца исходники хранятся в существующем bb-addons/plugins/bb-plugin-server-switcher. По прямому указанию владельца поддерживаемый форк выпускается под MIT с сохранением происхождения в NOTICE. Контракт: [спецификация](../specs/on-demand-switcher.md).

Уточнение владельца: внутри списка также использовать монохромные ComputerCloud вместо аватаров и цветных обводок; backend данных rings не изменять.
