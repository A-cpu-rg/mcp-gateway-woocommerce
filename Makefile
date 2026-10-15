# Local:  make up        (k3d cluster, images, secrets, both Helm releases)   then  make e2e
# VPS:    make secrets deploy-prod   (kubectl/helm pointed at the k3s cluster, images pushed to a registry)
CLUSTER     ?= urumi
STORE_NS    ?= store
PLATFORM_NS ?= platform
TAG         ?= dev
ADMIN_EMAIL ?= admin@example.com
IMAGES      := gateway woocommerce-mcp toolbox-mcp everything-mcp
HELM_WAIT   := --wait --timeout 10m

.PHONY: up cluster images import secrets deploy-local deploy-prod e2e status down charts-check

up: cluster images import secrets deploy-local status

cluster:
	k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create --config deploy/k3d.yaml

images:
	docker build --target gateway        --build-arg APP=gateway         -t urumi/gateway:$(TAG) .
	docker build --target app            --build-arg APP=woocommerce-mcp -t urumi/woocommerce-mcp:$(TAG) .
	docker build --target app            --build-arg APP=toolbox-mcp     -t urumi/toolbox-mcp:$(TAG) .
	docker build --target everything-mcp                                  -t urumi/everything-mcp:$(TAG) .

import:
	k3d image import -c $(CLUSTER) $(foreach i,$(IMAGES),urumi/$(i):$(TAG))

secrets:
	STORE_NS=$(STORE_NS) PLATFORM_NS=$(PLATFORM_NS) ADMIN_EMAIL=$(ADMIN_EMAIL) scripts/create-secrets.sh

deploy-local:
	helm upgrade --install store deploy/charts/store -n $(STORE_NS) \
	  -f deploy/charts/store/values-local.yaml --set gateway.namespace=$(PLATFORM_NS) $(HELM_WAIT)
	helm upgrade --install platform deploy/charts/platform -n $(PLATFORM_NS) \
	  -f deploy/charts/platform/values-local.yaml --set "upstreamNamespaces={$(STORE_NS)}" $(HELM_WAIT)
	kubectl -n $(PLATFORM_NS) rollout restart deploy/gateway   # pick up a refreshed gateway-llm Secret

deploy-prod:
	helm upgrade --install store deploy/charts/store -n $(STORE_NS) \
	  -f deploy/charts/store/values-prod.yaml --set gateway.namespace=$(PLATFORM_NS) $(HELM_WAIT)
	helm upgrade --install platform deploy/charts/platform -n $(PLATFORM_NS) \
	  -f deploy/charts/platform/values-prod.yaml --set "upstreamNamespaces={$(STORE_NS)}" $(HELM_WAIT)

# Definition-of-done checks. The dead-upstream check scales everything-mcp to 0 and restores it afterwards.
e2e:
	GATEWAY_URL=$${GATEWAY_URL:-http://app.localtest.me} \
	ADMIN_EMAIL=$$(kubectl -n $(PLATFORM_NS) get secret gateway-secrets -o jsonpath='{.data.ADMIN_EMAIL}' | base64 -d) \
	ADMIN_PASSWORD=$$(kubectl -n $(PLATFORM_NS) get secret gateway-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d) \
	KILL_CMD="kubectl -n $(PLATFORM_NS) scale deploy/everything-mcp --replicas=0" \
	node scripts/e2e.ts; rc=$$?; \
	kubectl -n $(PLATFORM_NS) scale deploy/everything-mcp --replicas=1 >/dev/null; exit $$rc

status:
	kubectl get pods,pvc,ingress -n $(STORE_NS)
	kubectl get pods,pvc,ingress -n $(PLATFORM_NS)
	@echo "Storefront: http://store.localtest.me   Dashboard: http://app.localtest.me"
	@echo "Dashboard admin: $$(kubectl -n $(PLATFORM_NS) get secret gateway-secrets -o jsonpath='{.data.ADMIN_EMAIL}' | base64 -d) / $$(kubectl -n $(PLATFORM_NS) get secret gateway-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d)"

down:
	k3d cluster delete $(CLUSTER)

# Static checks used by CI: lint and render both charts for both environments, validate the manifests.
charts-check:
	@for c in store platform; do for env in local prod; do \
	  helm lint deploy/charts/$$c -f deploy/charts/$$c/values-$$env.yaml >/dev/null || exit 1; \
	  helm template $$c deploy/charts/$$c -n $$c -f deploy/charts/$$c/values-$$env.yaml \
	    | kubeconform -strict -summary -kubernetes-version 1.33.0 || exit 1; \
	done; done
