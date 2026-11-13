{{- define "of.name" -}}{{ .Release.Name }}{{- end -}}
{{- define "of.labels" -}}
app.kubernetes.io/part-of: openfactory
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
{{- define "of.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag }}{{- end -}}
{{- define "of.generatedSecret" -}}{{ .Values.generated.existingSecret | default (printf "%s-generated" .Release.Name) }}{{- end -}}
{{- define "of.svc" -}}{{ printf "%s-%s.%s.svc" .root.Release.Name .name .root.Release.Namespace }}{{- end -}}
{{- define "of.dbSecret" -}}{{ if .Values.postgres.enabled }}{{ printf "%s-postgres" .Release.Name }}{{ else }}{{ required "externalDatabase.secretName is required when postgres.enabled=false" .Values.externalDatabase.secretName }}{{ end }}{{- end -}}
{{- define "of.dbFactoryKey" -}}{{ if .Values.postgres.enabled }}DATABASE_URL{{ else }}{{ .Values.externalDatabase.factoryUrlKey }}{{ end }}{{- end -}}
{{- define "of.dbLitellmKey" -}}{{ if .Values.postgres.enabled }}LITELLM_DATABASE_URL{{ else }}{{ .Values.externalDatabase.litellmUrlKey }}{{ end }}{{- end -}}
{{- define "of.proxyUrl" -}}http://{{ include "of.svc" (dict "root" . "name" "egress") }}:3128{{- end -}}
