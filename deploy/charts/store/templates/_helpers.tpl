{{- define "store.labels" -}}
app.kubernetes.io/part-of: store
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "store.scheme" -}}{{ if .Values.ingress.tlsSecret }}https{{ else }}http{{ end }}{{- end }}

{{/* Restricted-style security context for containers that run as an unprivileged user. */}}
{{- define "store.restricted" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/* WordPress DB settings, read by the official image's wp-config.php (also used by wp-cli in the setup Job). */}}
{{- define "store.wpDbEnv" -}}
- name: WORDPRESS_DB_HOST
  value: mariadb
- name: WORDPRESS_DB_NAME
  value: wordpress
- name: WORDPRESS_DB_USER
  value: wordpress
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.secrets.db }}, key: MARIADB_PASSWORD }
{{- end }}
