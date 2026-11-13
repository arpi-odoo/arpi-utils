// "My Tasks" card: open project.task records assigned to the API key's user.

const CLOSED_STATES = ['1_done', '1_canceled'];

const SPECIFICATION = {
    name: {},
    priority: {},
    state: {},
    write_date: {},
    project_id: { fields: { display_name: {} } },
    stage_id: { fields: { display_name: {} } },
    tag_ids: { fields: { display_name: {}, color: {} } },
};

async function fetchTasks(client, config) {
    const uid = await client.uid();
    const domain = [['user_ids', 'in', [uid]]];
    const projectIds = config.get('tasks.projectIds') || [];
    if (projectIds.length) {
        domain.push(['project_id', 'in', projectIds]);
    }
    if (!config.get('tasks.includeClosed')) {
        domain.push(['state', 'not in', CLOSED_STATES]);
    }
    domain.push(...(config.get('tasks.domain') || []));

    const { records } = await client.call('project.task', 'web_search_read', {
        domain,
        specification: SPECIFICATION,
        order: 'stage_id desc, priority desc, date_deadline, id desc',
        limit: 500,
    });
    const backlogStages = config.get('tasks.backlogStages') || [];
    return records.map((task) => ({
        id: task.id,
        name: task.name,
        priority: task.priority,
        state: task.state,
        updated: task.write_date,
        project: task.project_id ? { id: task.project_id.id, name: task.project_id.display_name } : null,
        stage: task.stage_id ? { id: task.stage_id.id, name: task.stage_id.display_name } : null,
        backlog: Boolean(task.stage_id) && backlogStages.includes(task.stage_id.display_name),
        tags: task.tag_ids.map((tag) => ({ name: tag.display_name, color: tag.color })),
        url: task.project_id
            ? `${client.url}/odoo/${task.project_id.id}/tasks/${task.id}`
            : `${client.url}/odoo/project.task/${task.id}`,
    }));
}

// Backlog tasks are listed but not counted.
function countTasks(tasks) {
    return tasks.filter((task) => !task.backlog).length;
}

module.exports = { fetchTasks, countTasks };
