# Redmine Top Menu Plugin
Redmine::Plugin.register :redmine_top_menu_issues do
  name 'Top Menu Issues'
  author 'Viaalink'
  description 'Adds quick links to the application top menu'
  version '1.2.0'
end

Redmine::MenuManager.map :top_menu do |menu|
  menu.push :issues_all, { controller: 'issues', action: 'index' }, caption: :label_issue_plural, after: :projects
  menu.push :gantt_view, { controller: 'gantts', action: 'show' }, caption: :label_gantt, after: :issues_all
  menu.push :calendar_view, { controller: 'calendars', action: 'show' }, caption: :label_calendar, after: :gantt_view
  menu.push :epics_view, '/issues?set_filter=1&tracker_id=4&status_id=*', caption: 'Epics', after: :calendar_view
  menu.push :kanban_view, '/kanban', caption: 'Kanban', after: :epics_view
  menu.push :dashboard_view, '/projects/business/dashboard', caption: 'Dashboard', after: :kanban_view
end
