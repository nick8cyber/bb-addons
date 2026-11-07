/**
 * Сколько composer-кнопок живого ввода сейчас смонтировано (§3.1 п. 4).
 * Хост рисует composer.actions только в развёрнутом композере — пока
 * наша кнопка там есть, FAB не нужен: на экране ровно одна кнопка.
 */
type Listener = () => void;

let count = 0;
const listeners = new Set<Listener>();
const emit = (): void => {
  for (const fn of listeners) fn();
};

export const micPresence = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): number {
    return count;
  },
  /** Регистрирует смонтированную кнопку; возвращает снятие регистрации. */
  mount(): () => void {
    count += 1;
    emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      count -= 1;
      emit();
    };
  },
};
