import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore } from '../persistence/JsonStore.js';
import { EventType } from '../events/EventBus.js';

/**
 * GoalSystem — spec section 15. Long-term goals ("build XOFT JARVIS") break
 * into projects ("Android Companion", "Voice"), which link to the actual
 * executable units the system already has: TaskPlanner tasks. This is
 * deliberately a thin layer — it doesn't re-implement execution, it just
 * gives tasks a durable home so progress survives across conversations
 * instead of every chat starting from zero.
 */
export class GoalSystem {
  constructor({ activityLog, eventBus, dataDir = './data', sqliteStore = null }) {
    this.activityLog = activityLog;
    this.eventBus = eventBus;
    this._store = new JsonStore({ dataDir, fileName: 'goals.json', kvKey: 'goals', defaultValue: { goals: [] }, sqliteStore });
  }

  _load() {
    return this._store.load();
  }

  _save(data) {
    this._store.save(data);
  }

  createGoal(description) {
    const data = this._load();
    const goal = {
      id: crypto.randomUUID(),
      description,
      status: 'active', // active | completed | abandoned
      projects: [],
      createdAt: new Date().toISOString(),
    };
    data.goals.push(goal);
    this._save(data);
    this.activityLog.log({ type: 'goal_created', detail: { goalId: goal.id, description } });
    this.eventBus?.emitEvent(EventType.GOAL_CREATED, { goalId: goal.id, description });
    return goal;
  }

  createProject(goalId, name) {
    const data = this._load();
    const goal = data.goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`GoalSystem: no goal '${goalId}'`);
    const project = { id: crypto.randomUUID(), name, taskIds: [], status: 'active', createdAt: new Date().toISOString() };
    goal.projects.push(project);
    this._save(data);
    this.activityLog.log({ type: 'project_created', detail: { goalId, projectId: project.id, name } });
    return project;
  }

  /** Links an existing TaskPlanner task id to a project so its progress counts toward the goal. */
  linkTask(goalId, projectId, taskId) {
    const data = this._load();
    const goal = data.goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`GoalSystem: no goal '${goalId}'`);
    const project = goal.projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`GoalSystem: no project '${projectId}' under goal '${goalId}'`);
    if (!project.taskIds.includes(taskId)) project.taskIds.push(taskId);
    this._save(data);
    this.activityLog.log({ type: 'task_linked_to_project', detail: { goalId, projectId, taskId } });
    return project;
  }

  get(goalId) {
    const goal = this._load().goals.find((g) => g.id === goalId);
    if (!goal) throw new Error(`GoalSystem: no goal '${goalId}'`);
    return goal;
  }

  list() {
    return this._load().goals;
  }

  /**
   * Real progress computed from actual linked task statuses via TaskPlanner
   * — not stored/guessed. Pass the live TaskPlanner in at call time.
   * @param {string} goalId
   * @param {import('../planner/TaskPlanner.js').TaskPlanner} taskPlanner
   */
  progress(goalId, taskPlanner) {
    const goal = this.get(goalId);
    const projects = goal.projects.map((project) => {
      const tasks = project.taskIds.map((taskId) => {
        try {
          return taskPlanner.get(taskId);
        } catch {
          return null; // task id was linked but no longer exists — skip it, don't crash
        }
      }).filter(Boolean);
      const completed = tasks.filter((t) => t.status === 'completed').length;
      return {
        id: project.id,
        name: project.name,
        taskCount: tasks.length,
        completedCount: completed,
        status: tasks.length > 0 && completed === tasks.length ? 'completed' : project.status,
      };
    });
    const totalTasks = projects.reduce((sum, p) => sum + p.taskCount, 0);
    const totalCompleted = projects.reduce((sum, p) => sum + p.completedCount, 0);
    return {
      goalId,
      description: goal.description,
      projects,
      totalTasks,
      totalCompleted,
      percentComplete: totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0,
    };
  }
}
