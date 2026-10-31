package assistantturns_test

import (
	"testing"

	"infinite-canvas/backend/internal/assistantturns"
)

func TestStudioProjectScopeSurvivesTurnLedgerAndUserIsolation(t *testing.T) {
	fx := openTurnFixture(t)
	turnID := "aabbccdd1122d1b2"
	if _, err := fx.turns.Begin(fx.userID, fx.canvasID, turnID, assistantturns.Input{StudioProjectIDs: []string{"studio-p1"}}); err != nil {
		t.Fatal(err)
	}
	scope, ok, err := fx.turns.ScopeForHost(fx.userID, turnID)
	if err != nil || !ok {
		t.Fatalf("scope missing: ok=%v err=%v", ok, err)
	}
	if len(scope.StudioProjectIDs) != 1 || scope.StudioProjectIDs[0] != "studio-p1" {
		t.Fatalf("Studio scope 未按回合保留: %+v", scope)
	}
	if _, ok, err := fx.turns.ScopeForHost("another-user", turnID); err != nil || ok {
		t.Fatalf("其他用户不得读取 Studio scope: ok=%v err=%v", ok, err)
	}
	reopened := fx.reopen(t)
	scope, ok, err = reopened.turns.ScopeForHost(fx.userID, turnID)
	if err != nil || !ok || len(scope.StudioProjectIDs) != 1 || scope.StudioProjectIDs[0] != "studio-p1" {
		t.Fatalf("重启后 Studio scope 丢失: %+v ok=%v err=%v", scope, ok, err)
	}
}
