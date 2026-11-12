// Synthetic contract fixtures; no real papers, external APIs or model results.
import type {
  KbAcknowledged,
  KbArea,
  KbAreaMap,
  KbAreaMaterials,
  KbDatedMaterials,
  KbExploreSnapshot,
  KbExploring,
  KbExploringList,
  KbFinding,
  KbFindingImported,
  KbFindings,
  KbFreshnessActionResult,
  KbFreshnessMarks,
  KbFunnelRun,
  KbJobs,
  KbLinkCheck,
  KbMaterialPublication,
  KbMaterialRepeats,
  KbReadMark,
  KbRepeatCheck,
  KbResearchGrant,
  KbResearchPermission,
  KbResearchTask,
  KbResearchTasks,
  KbScienceJournal,
  KbScienceResults,
  KbScienceSettings,
  KbScienceText,
  KbScienceWork,
  KbSignals,
  KbWeeklyCheck,
  KbWeeklySettings,
} from '../../../api/kb/types.gen';

interface ContractFixtures {
  KbAcknowledged: KbAcknowledged;
  KbArea: KbArea;
  KbAreaMap: KbAreaMap;
  KbAreaMaterials: KbAreaMaterials;
  KbDatedMaterials: KbDatedMaterials;
  KbExploreSnapshot: KbExploreSnapshot;
  KbExploring: KbExploring;
  KbExploringList: KbExploringList;
  KbFinding: KbFinding;
  KbFindingImported: KbFindingImported;
  KbFindings: KbFindings;
  KbFreshnessActionResult: KbFreshnessActionResult;
  KbFreshnessMarks: KbFreshnessMarks;
  KbFunnelRun: KbFunnelRun;
  KbJobs: KbJobs;
  KbLinkCheck: KbLinkCheck;
  KbMaterialPublication: KbMaterialPublication;
  KbMaterialRepeats: KbMaterialRepeats;
  KbReadMark: KbReadMark;
  KbRepeatCheck: KbRepeatCheck;
  KbResearchGrant: KbResearchGrant;
  KbResearchPermission: KbResearchPermission;
  KbResearchTask: KbResearchTask;
  KbResearchTasks: KbResearchTasks;
  KbScienceJournal: KbScienceJournal;
  KbScienceResults: KbScienceResults;
  KbScienceSettings: KbScienceSettings;
  KbScienceText: KbScienceText;
  KbScienceWork: KbScienceWork;
  KbSignals: KbSignals;
  KbWeeklyCheck: KbWeeklyCheck;
  KbWeeklySettings: KbWeeklySettings;
}

export const contractFixtures = {
  "KbScienceSettings": {
    "enabled": true,
    "consent_at": "2026-11-09T10:00:00Z",
    "openalex_key_configured": false,
    "full_text_hint_dismissed": false
  },
  "KbScienceResults": {
    "works": [
      {
        "id": "work-1",
        "provider": "openalex",
        "provider_id": "W-fixture-1",
        "doi": "10.1234/fixture",
        "arxiv_id": null,
        "title": "Fixture: claim-level grounding for agent memory",
        "authors": [
          "Sample Author"
        ],
        "publication": {
          "year": 2026,
          "date": "2026-10-15",
          "precision": "day",
          "origin": "crossref",
          "evidence_url": "https://example.org/fixture-paper"
        },
        "venue": "Fixture Journal",
        "abstract": "Synthetic sample: check each stored claim against its cited evidence.",
        "topic_ids": [
          "T-fixture-rag"
        ],
        "referenced_ids": [
          "W-fixture-root"
        ],
        "cited_by_count": 12,
        "locations": [
          {
            "url": "https://example.org/fixture-paper",
            "kind": "open_page",
            "open_access": true
          }
        ],
        "access": {
          "paid": false,
          "alternatives_checked": true,
          "free_alternative_ids": [],
          "suggestion_shown_at": null,
          "recommendation": null,
          "publisher_url": null
        },
        "publication_type": "article"
      }
    ],
    "next_cursor": null,
    "stop_reason": null
  },
  "KbScienceWork": {
    "id": "work-1",
    "provider": "openalex",
    "provider_id": "W-fixture-1",
    "doi": "10.1234/fixture",
    "arxiv_id": null,
    "title": "Fixture: claim-level grounding for agent memory",
    "authors": [
      "Sample Author"
    ],
    "publication": {
      "year": 2026,
      "date": "2026-10-15",
      "precision": "day",
      "origin": "crossref",
      "evidence_url": "https://example.org/fixture-paper"
    },
    "venue": "Fixture Journal",
    "abstract": "Synthetic sample: check each stored claim against its cited evidence.",
    "topic_ids": [
      "T-fixture-rag"
    ],
    "referenced_ids": [
      "W-fixture-root"
    ],
    "cited_by_count": 12,
    "locations": [
      {
        "url": "https://example.org/fixture-paper",
        "kind": "open_page",
        "open_access": true
      }
    ],
    "access": {
      "paid": false,
      "alternatives_checked": true,
      "free_alternative_ids": [],
      "suggestion_shown_at": null,
      "recommendation": null,
      "publisher_url": null
    },
    "publication_type": "article"
  },
  "KbScienceText": {
    "work_id": "work-1",
    "kind": "open_page",
    "text": "Synthetic fixture full text.",
    "source_url": "https://example.org/fixture-paper",
    "access": {
      "paid": false,
      "alternatives_checked": true,
      "free_alternative_ids": [],
      "suggestion_shown_at": null,
      "recommendation": null,
      "publisher_url": null
    }
  },
  "KbScienceJournal": {
    "records": [
      {
        "id": "egress-1",
        "requested_at": "2026-11-09T10:00:00Z",
        "provider": "openalex",
        "operation": "search",
        "destination_host": "api.openalex.org",
        "payload": {
          "topics": [
            "RAG"
          ],
          "dois": [],
          "ids": []
        },
        "outcome": "succeeded",
        "status_code": 200,
        "run_id": "run-1"
      }
    ],
    "next_cursor": null
  },
  "KbFunnelRun": {
    "id": "run-1",
    "state": "running",
    "stage": "novelty",
    "stop_reason": null,
    "budget": {
      "unit": "candidate",
      "limit": 30,
      "used": 9,
      "remaining": 21,
      "total_used": 9,
      "batch": 1,
      "free_only": false
    },
    "counters": {
      "checked": 240,
      "after_rules": 198,
      "on_topic": 38,
      "novelty_checked": 9,
      "new": 9,
      "covered": 0,
      "decided": 198
    },
    "checkpoint": {
      "id": "checkpoint-1",
      "revision": 1,
      "stage": "novelty",
      "cursor": "fixture-cursor",
      "completed_ids": [
        "work-1"
      ],
      "pending_ids": [
        "work-2"
      ],
      "saved_at": "2026-11-09T10:00:00Z"
    },
    "created_at": "2026-11-09T10:00:00Z",
    "updated_at": "2026-11-09T10:00:00Z",
    "decision_choices": [],
    "area_id": "area-ai",
    "task_id": "task-1",
    "query": "Verify wiki claims",
    "channels": [
      "continues",
      "branches",
      "search"
    ],
    "plan": [],
    "active_area_ids": [
      "topic-rag"
    ],
    "owner": "explore",
    "decision_provider": "local",
    "retry_at": null
  },
  "KbFindings": {
    "groups": [
      {
        "task_id": "task-1",
        "task_title": "Verify wiki claims",
        "findings": [
          {
            "id": "finding-1",
            "run_id": "run-1",
            "task_id": "task-1",
            "area_id": "topic-rag",
            "channel": "search",
            "label": "new",
            "work": {
              "id": "work-1",
              "provider": "openalex",
              "provider_id": "W-fixture-1",
              "doi": "10.1234/fixture",
              "arxiv_id": null,
              "title": "Fixture: claim-level grounding for agent memory",
              "authors": [
                "Sample Author"
              ],
              "publication": {
                "year": 2026,
                "date": "2026-10-15",
                "precision": "day",
                "origin": "crossref",
                "evidence_url": "https://example.org/fixture-paper"
              },
              "venue": "Fixture Journal",
              "abstract": "Synthetic sample: check each stored claim against its cited evidence.",
              "topic_ids": [
                "T-fixture-rag"
              ],
              "referenced_ids": [
                "W-fixture-root"
              ],
              "cited_by_count": 12,
              "locations": [
                {
                  "url": "https://example.org/fixture-paper",
                  "kind": "open_page",
                  "open_access": true
                }
              ],
              "access": {
                "paid": false,
                "alternatives_checked": true,
                "free_alternative_ids": [],
                "suggestion_shown_at": null,
                "recommendation": null,
                "publisher_url": null
              },
              "publication_type": "article"
            },
            "reason": "The library has retrieval methods but no claim verification method.",
            "theses": [
              {
                "text": "Synthetic sample: verify a claim when its source changes.",
                "label": "new",
                "wiki_refs": [
                  {
                    "page_id": "page-rag",
                    "title": "Retrieval-augmented generation",
                    "block_id": "statement-1"
                  }
                ]
              }
            ],
            "material_id": null,
            "text_available": "full_text",
            "created_at": "2026-11-09T10:00:00Z",
            "area_path": [
              "Artificial Intelligence",
              "Retrieval-augmented generation"
            ],
            "wiki_refs": [],
            "cites_materials": [],
            "shared_source_count": 0,
            "repeat_hint": null,
            "read_mark": null
          }
        ],
        "task_state": "running",
        "updated_at": "2026-11-09T10:00:00Z"
      }
    ],
    "covered_count": 12,
    "next_cursor": null,
    "checked_at": "2026-11-09T10:00:00Z",
    "full_text_key_hint_count": 2
  },
  "KbFinding": {
    "id": "finding-1",
    "run_id": "run-1",
    "task_id": "task-1",
    "area_id": "topic-rag",
    "channel": "search",
    "label": "new",
    "work": {
      "id": "work-1",
      "provider": "openalex",
      "provider_id": "W-fixture-1",
      "doi": "10.1234/fixture",
      "arxiv_id": null,
      "title": "Fixture: claim-level grounding for agent memory",
      "authors": [
        "Sample Author"
      ],
      "publication": {
        "year": 2026,
        "date": "2026-10-15",
        "precision": "day",
        "origin": "crossref",
        "evidence_url": "https://example.org/fixture-paper"
      },
      "venue": "Fixture Journal",
      "abstract": "Synthetic sample: check each stored claim against its cited evidence.",
      "topic_ids": [
        "T-fixture-rag"
      ],
      "referenced_ids": [
        "W-fixture-root"
      ],
      "cited_by_count": 12,
      "locations": [
        {
          "url": "https://example.org/fixture-paper",
          "kind": "open_page",
          "open_access": true
        }
      ],
      "access": {
        "paid": false,
        "alternatives_checked": true,
        "free_alternative_ids": [],
        "suggestion_shown_at": null,
        "recommendation": null,
        "publisher_url": null
      },
      "publication_type": "article"
    },
    "reason": "The library has retrieval methods but no claim verification method.",
    "theses": [
      {
        "text": "Synthetic sample: verify a claim when its source changes.",
        "label": "new",
        "wiki_refs": [
          {
            "page_id": "page-rag",
            "title": "Retrieval-augmented generation",
            "block_id": "statement-1"
          }
        ]
      }
    ],
    "material_id": null,
    "text_available": "full_text",
    "created_at": "2026-11-09T10:00:00Z",
    "area_path": [
      "Artificial Intelligence",
      "Retrieval-augmented generation"
    ],
    "wiki_refs": [],
    "cites_materials": [],
    "shared_source_count": 0,
    "repeat_hint": null,
    "read_mark": null
  },
  "KbExploring": {
    "id": "reading-1",
    "finding_id": "finding-1",
    "chat_id": "chat-reading-1",
    "mode": "brief_tour",
    "text_kind": "open_page",
    "material_id": null,
    "started_at": "2026-11-09T10:00:00Z"
  },
  "KbExploringList": {
    "items": [
      {
        "id": "reading-1",
        "finding_id": "finding-1",
        "chat_id": "chat-reading-1",
        "mode": "brief_tour",
        "text_kind": "open_page",
        "material_id": null,
        "started_at": "2026-11-09T10:00:00Z"
      }
    ]
  },
  "KbFindingImported": {
    "finding_id": "finding-1",
    "material_id": "material-1",
    "content": "full_text",
    "to_wiki": true
  },
  "KbAreaMap": {
    "parent_id": null,
    "breadcrumbs": [],
    "areas": [
      {
        "id": "field-cs",
        "parent_id": null,
        "taxonomy_id": "17",
        "level": "field",
        "name": "Computer Science",
        "original_name": "Computer Science",
        "hidden": false,
        "pinned": true,
        "topic_ids": [],
        "has_children": true,
        "pages": 128,
        "sources": 34,
        "newest_source_year": 2026,
        "recent_activity_at": "2026-11-09T10:00:00Z",
        "new_findings": 9,
        "marked_materials": 12,
        "materials": 12,
        "wiki_share": 0.4,
        "depth": "dense",
        "children_covered": 0,
        "children_total": 0,
        "gap_reason": null
      }
    ],
    "total_pages": 320,
    "worth_closing": [],
    "unsorted_materials": 0,
    "labelling": { "state": "idle", "job_id": null, "done": 0, "total": 0, "reason_code": null, "engine": null },
    "total_sources": 131
  },
  "KbArea": {
    "id": "field-cs",
    "parent_id": null,
    "taxonomy_id": "17",
    "level": "field",
    "name": "Computer Science",
    "original_name": "Computer Science",
    "hidden": false,
    "pinned": true,
    "topic_ids": [],
    "has_children": true,
    "pages": 128,
    "sources": 34,
    "newest_source_year": 2026,
    "recent_activity_at": "2026-11-09T10:00:00Z",
    "new_findings": 9,
    "marked_materials": 12,
    "materials": 12,
    "wiki_share": 0.4,
    "depth": "dense",
    "children_covered": 0,
    "children_total": 0,
    "gap_reason": null
  },
  "KbAreaMaterials": {
    "materials": [
      {
        "material_id": "material-1",
        "title": "Fixture: Lecture 7 — RAG in practice",
        "kind": "audio",
        "publication": {
          "year": 2026,
          "date": "2026-10-15",
          "precision": "day",
          "origin": "crossref",
          "evidence_url": "https://example.org/fixture-paper"
        },
        "wiki_pages": 3,
        "read_mark": "useful_method",
        "repeat_status": "checked",
        "repeated_percent": 80,
        "repeats_source_titles": [
          "Fixture: Retrieval methods"
        ],
        "freshness_mark_ids": [
          "mark-1"
        ]
      }
    ],
    "next_cursor": null,
    "not_checked_count": 0
  },
  "KbReadMark": {
    "material_id": "material-1",
    "finding_id": null,
    "value": "useful_method",
    "updated_at": "2026-11-09T10:00:00Z"
  },
  "KbSignals": {
    "signals": [
      {
        "id": "signal-1",
        "subject": {
          "kind": "user",
          "id": "local-user"
        },
        "predicate": "read_mark_set",
        "object": {
          "kind": "material",
          "id": "material-1"
        },
        "occurred_at": "2026-11-09T10:00:00Z",
        "origin": "user_action",
        "value": "useful_method",
        "evidence_id": "read-mark-material-1",
        "supersedes_id": null
      }
    ],
    "next_cursor": null
  },
  "KbResearchTask": {
    "id": "task-1",
    "title": "Verify wiki claims",
    "description": "Find methods to verify wiki claims",
    "chat_id": "chat-research-1",
    "origin_chat_id": null,
    "area_id": "area-ai",
    "topics": [{ "text": "LLM agents", "source": "proposed", "area_id": null }],
    "run": {
      "id": "run-1",
      "state": "running",
      "stage": "novelty",
      "stop_reason": null,
      "budget": {
        "unit": "candidate",
        "limit": 30,
        "used": 9,
        "remaining": 21,
        "total_used": 9,
        "batch": 1,
        "free_only": false
      },
      "counters": {
        "checked": 240,
        "after_rules": 198,
        "on_topic": 38,
        "novelty_checked": 9,
        "new": 9,
        "covered": 0,
        "decided": 198
      },
      "checkpoint": {
        "id": "checkpoint-1",
        "revision": 1,
        "stage": "novelty",
        "cursor": "fixture-cursor",
        "completed_ids": [
          "work-1"
        ],
        "pending_ids": [
          "work-2"
        ],
        "saved_at": "2026-11-09T10:00:00Z"
      },
      "created_at": "2026-11-09T10:00:00Z",
      "updated_at": "2026-11-09T10:00:00Z",
      "decision_choices": [],
      "owner": "research",
      "decision_provider": "local",
      "retry_at": null
    },
    "finding_count": 9,
    "created_at": "2026-11-09T10:00:00Z",
    "updated_at": "2026-11-09T10:00:00Z"
  },
  "KbResearchTasks": {
    "tasks": [
      {
        "id": "task-1",
        "title": "Verify wiki claims",
        "description": "Find methods to verify wiki claims",
        "chat_id": "chat-research-1",
        "origin_chat_id": null,
        "area_id": "area-ai",
        "topics": [{ "text": "LLM agents", "source": "proposed", "area_id": null }],
        "run": {
          "id": "run-1",
          "state": "running",
          "stage": "novelty",
          "stop_reason": null,
          "budget": {
            "unit": "candidate",
            "limit": 30,
            "used": 9,
            "remaining": 21,
            "total_used": 9,
            "batch": 1,
            "free_only": false
          },
          "counters": {
            "checked": 240,
            "after_rules": 198,
            "on_topic": 38,
            "novelty_checked": 9,
            "new": 9,
            "covered": 0,
            "decided": 198
          },
          "checkpoint": {
            "id": "checkpoint-1",
            "revision": 1,
            "stage": "novelty",
            "cursor": "fixture-cursor",
            "completed_ids": [
              "work-1"
            ],
            "pending_ids": [
              "work-2"
            ],
            "saved_at": "2026-11-09T10:00:00Z"
          },
          "created_at": "2026-11-09T10:00:00Z",
          "updated_at": "2026-11-09T10:00:00Z",
          "decision_choices": [],
          "owner": "research",
          "decision_provider": "local",
          "retry_at": null
        },
        "finding_count": 9,
        "created_at": "2026-11-09T10:00:00Z",
        "updated_at": "2026-11-09T10:00:00Z"
      }
    ],
    "next_cursor": null
  },
  "KbResearchPermission": {
    "id": "permission-1",
    "kind": "research_start",
    "chat_id": "chat-1",
    "arguments": {
      "description": "Find methods to verify wiki claims"
    },
    "topics": [
      "claim verification methods",
      "fact-checking knowledge bases"
    ],
    "status": "pending",
    "auto": false,
    "task_id": null,
    "created_at": "2026-11-09T10:00:00Z",
    "type": "research",
    "engine": "claude_code",
    "reason": null,
    "task_title": null,
    "task_state": null
  },
  "KbResearchGrant": {
    "chat_id": "chat-1",
    "kind": "research_start",
    "allowed": false,
    "granted_at": null
  },
  "KbExploreSnapshot": {
    "map": {
      "parent_id": null,
      "breadcrumbs": [],
      "areas": [
        {
          "id": "field-cs",
          "parent_id": null,
          "taxonomy_id": "17",
          "level": "field",
          "name": "Computer Science",
          "original_name": "Computer Science",
          "hidden": false,
          "pinned": true,
          "topic_ids": [],
          "has_children": true,
          "pages": 128,
          "sources": 34,
          "newest_source_year": 2026,
          "recent_activity_at": "2026-11-09T10:00:00Z",
          "new_findings": 9,
          "marked_materials": 12,
          "materials": 12,
          "wiki_share": 0.4,
          "depth": "dense",
          "children_covered": 0,
          "children_total": 0,
          "gap_reason": null
        }
      ],
      "total_pages": 320,
      "worth_closing": [],
      "unsorted_materials": 0,
      "labelling": { "state": "idle", "job_id": null, "done": 0, "total": 0, "reason_code": null, "engine": null },
      "total_sources": 131
    },
    "findings": {
      "groups": [
        {
          "task_id": "task-1",
          "task_title": "Verify wiki claims",
          "findings": [
            {
              "id": "finding-1",
              "run_id": "run-1",
              "task_id": "task-1",
              "area_id": "topic-rag",
              "channel": "search",
              "label": "new",
              "work": {
                "id": "work-1",
                "provider": "openalex",
                "provider_id": "W-fixture-1",
                "doi": "10.1234/fixture",
                "arxiv_id": null,
                "title": "Fixture: claim-level grounding for agent memory",
                "authors": [
                  "Sample Author"
                ],
                "publication": {
                  "year": 2026,
                  "date": "2026-10-15",
                  "precision": "day",
                  "origin": "crossref",
                  "evidence_url": "https://example.org/fixture-paper"
                },
                "venue": "Fixture Journal",
                "abstract": "Synthetic sample: check each stored claim against its cited evidence.",
                "topic_ids": [
                  "T-fixture-rag"
                ],
                "referenced_ids": [
                  "W-fixture-root"
                ],
                "cited_by_count": 12,
                "locations": [
                  {
                    "url": "https://example.org/fixture-paper",
                    "kind": "open_page",
                    "open_access": true
                  }
                ],
                "access": {
                  "paid": false,
                  "alternatives_checked": true,
                  "free_alternative_ids": [],
                  "suggestion_shown_at": null,
                  "recommendation": null,
                  "publisher_url": null
                },
                "publication_type": "article"
              },
              "reason": "The library has retrieval methods but no claim verification method.",
              "theses": [
                {
                  "text": "Synthetic sample: verify a claim when its source changes.",
                  "label": "new",
                  "wiki_refs": [
                    {
                      "page_id": "page-rag",
                      "title": "Retrieval-augmented generation",
                      "block_id": "statement-1"
                    }
                  ]
                }
              ],
              "material_id": null,
              "text_available": "full_text",
              "created_at": "2026-11-09T10:00:00Z",
              "area_path": [
                "Artificial Intelligence",
                "Retrieval-augmented generation"
              ],
              "wiki_refs": [],
              "cites_materials": [],
              "shared_source_count": 0,
              "repeat_hint": null,
              "read_mark": null
            }
          ],
          "task_state": "running",
          "updated_at": "2026-11-09T10:00:00Z"
        }
      ],
      "covered_count": 12,
      "next_cursor": null,
      "checked_at": "2026-11-09T10:00:00Z",
      "full_text_key_hint_count": 2
    },
    "signals": {
      "signals": [
        {
          "id": "signal-1",
          "subject": {
            "kind": "user",
            "id": "local-user"
          },
          "predicate": "read_mark_set",
          "object": {
            "kind": "material",
            "id": "material-1"
          },
          "occurred_at": "2026-11-09T10:00:00Z",
          "origin": "user_action",
          "value": "useful_method",
          "evidence_id": "read-mark-material-1",
          "supersedes_id": null
        }
      ],
      "next_cursor": null
    },
    "tasks": {
      "tasks": [
        {
          "id": "task-1",
          "title": "Verify wiki claims",
          "description": "Find methods to verify wiki claims",
          "chat_id": "chat-research-1",
          "origin_chat_id": null,
          "area_id": "area-ai",
          "topics": [{ "text": "LLM agents", "source": "proposed", "area_id": null }],
          "run": {
            "id": "run-1",
            "state": "running",
            "stage": "novelty",
            "stop_reason": null,
            "budget": {
              "unit": "candidate",
              "limit": 30,
              "used": 9,
              "remaining": 21,
              "total_used": 9,
              "batch": 1,
              "free_only": false
            },
            "counters": {
              "checked": 240,
              "after_rules": 198,
              "on_topic": 38,
              "novelty_checked": 9,
              "new": 9,
              "covered": 0,
              "decided": 198
            },
            "checkpoint": {
              "id": "checkpoint-1",
              "revision": 1,
              "stage": "novelty",
              "cursor": "fixture-cursor",
              "completed_ids": [
                "work-1"
              ],
              "pending_ids": [
                "work-2"
              ],
              "saved_at": "2026-11-09T10:00:00Z"
            },
            "created_at": "2026-11-09T10:00:00Z",
            "updated_at": "2026-11-09T10:00:00Z",
            "decision_choices": [],
            "owner": "research",
            "decision_provider": "local",
            "retry_at": null
          },
          "finding_count": 9,
          "created_at": "2026-11-09T10:00:00Z",
          "updated_at": "2026-11-09T10:00:00Z"
        }
      ],
      "next_cursor": null
    }
  },
  "KbMaterialPublication": {
    "material_id": "material-1",
    "publication": {
      "year": 2026,
      "date": "2026-10-15",
      "precision": "day",
      "origin": "crossref",
      "evidence_url": "https://example.org/fixture-paper"
    }
  },
  "KbDatedMaterials": {
    "materials": [
      {
        "material_id": "material-1",
        "title": "Fixture: Lecture 7 — RAG in practice",
        "kind": "audio",
        "publication": {
          "year": 2026,
          "date": "2026-10-15",
          "precision": "day",
          "origin": "crossref",
          "evidence_url": "https://example.org/fixture-paper"
        },
        "wiki_pages": 3,
        "read_mark": "useful_method",
        "repeat_status": "checked",
        "repeated_percent": 80,
        "repeats_source_titles": [
          "Fixture: Retrieval methods"
        ],
        "freshness_mark_ids": [
          "mark-1"
        ]
      }
    ],
    "unknown_date": [],
    "next_cursor": null
  },
  "KbLinkCheck": {
    "id": "run-1",
    "state": "running",
    "stage": "links",
    "stop_reason": null,
    "budget": {
      "unit": "link",
      "limit": 100,
      "used": 1,
      "remaining": 99,
      "total_used": 1,
      "batch": 1,
      "free_only": true
    },
    "counters": {
      "checked": 240,
      "after_rules": 198,
      "on_topic": 38,
      "novelty_checked": 9,
      "new": 9,
      "covered": 0,
      "decided": 198
    },
    "checkpoint": {
      "id": "checkpoint-1",
      "revision": 1,
      "stage": "novelty",
      "cursor": "fixture-cursor",
      "completed_ids": [
        "work-1"
      ],
      "pending_ids": [
        "work-2"
      ],
      "saved_at": "2026-11-09T10:00:00Z"
    },
    "created_at": "2026-11-09T10:00:00Z",
    "updated_at": "2026-11-09T10:00:00Z",
    "decision_choices": [],
    "observations": [
      {
        "material_id": "material-1",
        "url": "https://example.org/fixture-paper",
        "outcome": "suspected_gone",
        "reason": "http_404",
        "status_code": 404,
        "checked_at": "2026-11-09T10:00:00Z",
        "first_gone_at": "2026-11-09T10:00:00Z",
        "confirm_after": "2026-11-10T10:00:00Z"
      }
    ],
    "owner": "links",
    "decision_provider": "local",
    "retry_at": null
  },
  "KbWeeklySettings": {
    "enabled": true,
    "last_completed_at": "2026-11-09T10:00:00Z",
    "next_due_at": "2026-11-16T10:00:00Z",
    "missed": false,
    "latest_check_id": "run-1",
    "candidates_waiting": 14
  },
  "KbWeeklyCheck": {
    "id": "run-1",
    "state": "running",
    "stage": "novelty",
    "stop_reason": null,
    "budget": {
      "unit": "candidate",
      "limit": 30,
      "used": 9,
      "remaining": 21,
      "total_used": 9,
      "batch": 1,
      "free_only": true
    },
    "counters": {
      "checked": 240,
      "after_rules": 198,
      "on_topic": 38,
      "novelty_checked": 9,
      "new": 9,
      "covered": 0,
      "decided": 198
    },
    "checkpoint": {
      "id": "checkpoint-1",
      "revision": 1,
      "stage": "novelty",
      "cursor": "fixture-cursor",
      "completed_ids": [
        "work-1"
      ],
      "pending_ids": [
        "work-2"
      ],
      "saved_at": "2026-11-09T10:00:00Z"
    },
    "created_at": "2026-11-09T10:00:00Z",
    "updated_at": "2026-11-09T10:00:00Z",
    "decision_choices": [],
    "trigger": "scheduled",
    "candidates_waiting": 14,
    "notifications": [
      {
        "id": "notification-1",
        "kind": "weekly_check_started",
        "job_id": "run-1",
        "task_id": null,
        "created_at": "2026-11-09T10:00:00Z",
        "message": "SKAZ works in the tray; Quit pauses the check, it resumes next launch"
      }
    ],
    "owner": "weekly",
    "decision_provider": "local",
    "retry_at": null,
    "candidate_ids": [
      "work-1",
      "work-2"
    ],
    "new_versions": 2,
    "retractions": 1,
    "newer_contradictions": 0
  },
  "KbFreshnessMarks": {
    "marks": [
      {
        "id": "mark-1",
        "material_id": "material-1",
        "kind": "new_version",
        "reason": "Version 3 supersedes version 2.",
        "evidence_url": "https://example.org/fixture-v3",
        "replacement_work_id": "work-2",
        "version": "v3",
        "publication": {
          "year": 2026,
          "date": "2026-10-15",
          "precision": "day",
          "origin": "crossref",
          "evidence_url": "https://example.org/fixture-paper"
        },
        "affected_statements": [
          {
            "page_id": "page-rag",
            "title": "Retrieval-augmented generation",
            "block_id": "statement-1",
            "sole_source": false,
            "also_supported_by": []
          }
        ],
        "actions": [
          "replace_version",
          "keep_marked"
        ],
        "kept_marked": false,
        "created_at": "2026-11-09T10:00:00Z",
        "evidence_label": "arXiv version history",
        "checked_at": "2026-11-09T10:00:00Z",
        "current_version": "v2"
      }
    ],
    "last_link_check": null
  },
  "KbFreshnessActionResult": {
    "mark": {
      "id": "mark-1",
      "material_id": "material-1",
      "kind": "new_version",
      "reason": "Version 3 supersedes version 2.",
      "evidence_url": "https://example.org/fixture-v3",
      "replacement_work_id": "work-2",
      "version": "v3",
      "publication": {
        "year": 2026,
        "date": "2026-10-15",
        "precision": "day",
        "origin": "crossref",
        "evidence_url": "https://example.org/fixture-paper"
      },
      "affected_statements": [
        {
          "page_id": "page-rag",
          "title": "Retrieval-augmented generation",
          "block_id": "statement-1",
          "sole_source": false,
          "also_supported_by": []
        }
      ],
      "actions": [
        "replace_version",
        "keep_marked"
      ],
      "kept_marked": false,
      "created_at": "2026-11-09T10:00:00Z",
      "evidence_label": "arXiv version history",
      "checked_at": "2026-11-09T10:00:00Z",
      "current_version": "v2"
    },
    "ingest_job_id": null
  },
  "KbMaterialRepeats": {
    "material_id": "material-1",
    "status": "checked",
    "percent": 80,
    "repeated": 4,
    "total": 5,
    "from_materials": [
      {
        "material_id": "material-2",
        "title": "Fixture: Retrieval methods"
      }
    ],
    "paragraphs": [
      {
        "paragraph_id": "paragraph-1",
        "fragment_ids": [
          1
        ],
        "wiki_refs": [
          {
            "page_id": "page-rag",
            "title": "Retrieval-augmented generation",
            "block_id": "statement-1"
          }
        ],
        "from_materials": [
          {
            "material_id": "material-2",
            "title": "Fixture: Retrieval methods"
          }
        ],
        "repeated_statements": 1,
        "total_statements": 1,
        "fully_repeated": true
      }
    ],
    "checked_at": "2026-11-09T10:00:00Z"
  },
  "KbRepeatCheck": {
    "id": "run-1",
    "state": "running",
    "stage": "repeats",
    "stop_reason": null,
    "budget": {
      "unit": "claim_comparison",
      "limit": 30,
      "used": 18,
      "remaining": 12,
      "total_used": 18,
      "batch": 1,
      "free_only": false
    },
    "counters": {
      "checked": 240,
      "after_rules": 198,
      "on_topic": 38,
      "novelty_checked": 9,
      "new": 9,
      "covered": 0,
      "decided": 198
    },
    "checkpoint": {
      "id": "checkpoint-1",
      "revision": 1,
      "stage": "novelty",
      "cursor": "fixture-cursor",
      "completed_ids": [
        "work-1"
      ],
      "pending_ids": [
        "work-2"
      ],
      "saved_at": "2026-11-09T10:00:00Z"
    },
    "created_at": "2026-11-09T10:00:00Z",
    "updated_at": "2026-11-09T10:00:00Z",
    "decision_choices": [],
    "area_id": "area-ai",
    "materials_checked": 9,
    "materials_remaining": 21,
    "owner": "repeats",
    "decision_provider": "local",
    "retry_at": null
  },
  "KbAcknowledged": {
    "ok": true
  },
  "KbJobs": {
    "jobs": [
      {
        "id": "run-1",
        "owner": "research",
        "title": "Verify wiki claims",
        "state": "running",
        "stage": "novelty",
        "stop_reason": null,
        "budget": {
          "unit": "candidate",
          "limit": 30,
          "used": 9,
          "remaining": 21,
          "total_used": 9,
          "batch": 1,
          "free_only": false
        },
        "task_id": "task-1",
        "chat_id": "chat-research-1",
        "area_id": "area-ai",
        "updated_at": "2026-11-09T10:00:00Z"
      }
    ]
  }
} satisfies ContractFixtures;
