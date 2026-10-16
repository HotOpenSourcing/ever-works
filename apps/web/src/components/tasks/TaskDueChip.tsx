'use client';

import { useTranslations } from 'next-intl';
import { CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { Task } from '@/lib/api/tasks';

/**
 * EW-P2-3 — a Task's due date on a board card. Red once the date has passed
 * while the Task is still open; a done or cancelled Task shows its date
 * plainly (it is no longer late for anything).
 */
export function TaskDueChip({ task }: { task: Pick<Task, 'dueAt' | 'status'> }) {
    const t = useTranslations('dashboard.tasksPage.planning');
    if (!task.dueAt) return null;
    const due = new Date(task.dueAt);
    if (Number.isNaN(due.getTime())) return null;
    const closed = task.status === 'done' || task.status === 'cancelled';
    const overdue = !closed && due.getTime() < Date.now();
    const date = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return (
        <span
            data-testid="task-due-chip"
            data-overdue={overdue ? 'true' : 'false'}
            title={due.toLocaleString()}
            className={cn(
                'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded',
                overdue
                    ? 'bg-danger/10 text-danger'
                    : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary',
            )}
        >
            <CalendarClock className="w-3 h-3" aria-hidden />
            {overdue ? t('overdue', { date }) : t('due', { date })}
        </span>
    );
}
