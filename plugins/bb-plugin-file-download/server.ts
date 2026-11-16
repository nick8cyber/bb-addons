// Серверная логика не нужна: чтение файлов идёт через авторизованный
// useSdk() на фронтенде, скачивание — через experimental_saveFile.
// Точка входа требуется `bb plugin build` (bb.server обязателен).
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(_bb: BbPluginApi): Promise<void> {}
