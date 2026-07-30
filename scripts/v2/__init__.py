"""Multi-tenant (v2) schema query generators.

Same public interface as the v1 modules in ``scripts/`` — same class names,
same constructor signatures, same ``generate_source_data_query`` helpers — so
``services/`` can swap between v1 and v2 by import alone.

Only the emitted SQL differs. The Python diff logic is deliberately identical
to v1 so switching versions cannot change *which* rows are considered added,
removed or flipped — only which tables those changes are written to.

Schema mapping v1 → v2
──────────────────────
  tenant_feature                   → tenant_feature_config (all scope cols NULL)
  tenant_product_feature           → tenant_feature_config (product_id set)
  branch_product_module            → tenant_product + tenant_branch_product
  branch_product_transaction_type  → tenant_product_transaction_type
                                     + tenant_branch_product_transaction_type
  workflow.branch_product_module_id→ workflow.{tenant,module,branch,product,
                                              transaction_type}_id
  (new)                            → tenant_module_binding
  (new)                            → product_transaction_type_module
"""
