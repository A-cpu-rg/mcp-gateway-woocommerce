{{- define "platform.labels" -}}
app.kubernetes.io/part-of: platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "platform.podSecurity" -}}
runAsUser: 1000
runAsGroup: 1000
runAsNonRoot: true
seccompProfile: { type: RuntimeDefault }
{{- end }}

{{- define "platform.restricted" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/* A small stateless Node MCP server: Deployment + ClusterIP Service. Args: (dict "ctx" $ "name" .. "v" ..) */}}
{{- define "platform.mcpServer" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  labels: {{- include "platform.labels" .ctx | nindent 4 }}
spec:
  type: ClusterIP
  selector: { app.kubernetes.io/name: {{ .name }} }
  ports: [{ name: http, port: 8080, targetPort: http }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .name }}
  labels: {{- include "platform.labels" .ctx | nindent 4 }}
    app.kubernetes.io/name: {{ .name }}
spec:
  replicas: 1
  selector:
    matchLabels: { app.kubernetes.io/name: {{ .name }} }
  template:
    metadata:
      labels: {{- include "platform.labels" .ctx | nindent 8 }}
        app.kubernetes.io/name: {{ .name }}
        mcp.urumi.io/upstream: "true"
    spec:
      automountServiceAccountToken: false
      securityContext: {{- include "platform.podSecurity" .ctx | nindent 8 }}
      containers:
        - name: {{ .name }}
          image: {{ .v.image }}
          imagePullPolicy: {{ .v.pullPolicy }}
          securityContext: {{- include "platform.restricted" .ctx | nindent 12 }}
          {{- with .envFrom }}
          envFrom: {{- toYaml . | nindent 12 }}
          {{- end }}
          ports: [{ name: http, containerPort: 8080 }]
          readinessProbe:
            {{- toYaml .readiness | nindent 12 }}
            periodSeconds: 10
          livenessProbe:
            tcpSocket: { port: http }
            periodSeconds: 20
          resources: {{- toYaml .v.resources | nindent 12 }}
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      volumes: [{ name: tmp, emptyDir: {} }]
{{- end }}
